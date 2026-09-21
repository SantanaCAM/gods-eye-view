import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * @file Road geometry from OpenMapTiles-schema vector tiles, returned in the
 * Overpass JSON shape the traffic layer already parses.
 *
 * WHY THIS EXISTS (Project Adam / Godseye fork, 2026-09-21). Every full-planet
 * Overpass instance is unreachable from this deployment's WAN address:
 * `overpass-api.de`, `lz4.overpass-api.de` and `z.overpass-api.de` return a
 * bare Apache **406** to any request including `/api/status` (an IP-level
 * block, not a query problem); `overpass.kumi.systems`, `overpass.private.coffee`
 * and `overpass.monicz.dev` never answer (the first two are one host — kumi is
 * a CNAME to private.coffee); `maps.mail.ru` returns 504; `overpass.osm.ch`
 * answers 200 in 0.6 s but is a Swiss regional instance and returns **zero
 * ways** for California. Measured, not inferred — from both kratos and CT 103.
 *
 * So the traffic layer hung forever at "LOADING": TomTom flow tiles returned
 * 200 beside a `POST /api/overpass` that never resolved. The missing half was
 * never the traffic data — it was the road centrelines the dots run along.
 *
 * Vector tiles solve it structurally rather than by finding one more mirror:
 * they are served from a CDN (no per-IP ban to fall foul of), need no key,
 * cover the planet, and arrive on the SAME z/x/y grid as the TomTom flow
 * tiles this layer already fetches — the first tile verified here, z12
 * 671/1585, is the exact tile the TomTom key was verified against.
 *
 * The output is deliberately Overpass-shaped. `normalizeOverpassRoads` in
 * `src/sources/overpassRoads.js` reads `elements[].geometry[{lat,lon}]` and
 * `elements[].tags.highway`, so emitting that shape means **not one line of
 * client code changes** — dot animation, flow matching, budgets, colouring and
 * the jam heat-lines all keep the behaviour that was already verified working.
 *
 * Set `GEV_ROADS_SOURCE=overpass` to fall back to the upstream mirrors.
 *
 * @module server/providers/overpass/roadTiles
 */

/** Road source: 'vector-tiles' (default here) or 'overpass' (upstream mirrors). */
const ROADS_SOURCE = (
  process.env.GEV_ROADS_SOURCE || 'vector-tiles'
).toLowerCase();

/**
 * TileJSON endpoint. Resolved rather than hardcoded because OpenFreeMap serves
 * tiles under a dated build path (`/planet/20260913_164504_pt/...`) that rolls
 * forward; pinning one would quietly go stale months from now.
 */
const TILEJSON_URL =
  process.env.GEV_ROADS_TILEJSON || 'https://tiles.openfreemap.org/planet';

/** Attribution required by the data licence (ODbL) — surfaced in the payload. */
const ROADS_ATTRIBUTION = '© OpenStreetMap contributors, via OpenFreeMap';

/** How long a resolved TileJSON tile-URL template is reused (ms). */
const TILEJSON_TTL_MS = 6 * 3_600_000;

/** Decoded-tile memory cache TTL (ms). Road centrelines are static for months. */
const TILE_TTL_MS = 24 * 3_600_000;

/** Max decoded tiles held in memory before oldest-first eviction. */
const TILE_CACHE_MAX = 256;

/** Max tiles fetched to satisfy one viewport request. */
const MAX_TILES = 12;

/** Zoom bounds. z14 is full detail; z10 still carries motorway→tertiary. */
const MIN_ZOOM = 10;
const MAX_ZOOM = 14;

/** Per-tile fetch timeout (ms). */
const TILE_TIMEOUT_MS = 12_000;

/** Hard cap on emitted ways, so a wide viewport cannot produce a huge payload. */
const MAX_ELEMENTS = 4000;

/**
 * OpenMapTiles `transportation.class` → OSM `highway` value.
 *
 * Classes absent here are dropped on purpose: `path`, `track`, `rail`,
 * `busway`, `ferry`, `aerialway`, `bridge` (a casing geometry, not a road) and
 * `minor_construction` are not roads traffic dots belong on. `service` is
 * dropped for a subtler reason: it is driveways, alleys and parking aisles, and
 * mapping it to `unclassified` flooded the result — a first Modesto viewport
 * came back 2,401 service ways out of 4,009, truncating at the element cap and
 * pushing real residential streets out of the payload. OSM's genuine
 * `highway=unclassified` still arrives, via `minor` + `subclass` below. Link
 * roads/ramps
 * are already folded into their parent class by the schema and carry `ramp:1`,
 * so motorway ramps survive as `motorway` rather than being lost to a
 * `motorway_link` value the caller's regex never allows.
 */
const CLASS_TO_HIGHWAY = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
};

/** `subclass` values that refine the schema's catch-all `minor` class. */
const MINOR_SUBCLASS = {
  residential: 'residential',
  living_street: 'residential',
  unclassified: 'unclassified',
  road: 'unclassified',
};

/**
 * The exact query `buildOverpassQuery` emits in `src/layers/traffic/source.js`.
 * Matching narrowly is the point: anything that is not a traffic road fetch —
 * CCTV `around:`, admin `is_in`, annotation pivots — must still reach the real
 * Overpass mirrors untouched.
 */
const ROAD_QUERY_RE =
  /^\[out:json\]\[timeout:\d+\];\s*\(\s*way\["highway"~"\^\(([a-z|_]+)\)\$"\]\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*;\s*\)\s*;\s*out geom qt;\s*$/;

/** @type {Map<string,{tile:Object|null,at:number}>} Decoded tiles by `z/x/y`. */
const _tileCache = new Map();

/** @type {{template:string,at:number}|null} Cached TileJSON resolution. */
let _tileTemplate = null;

/** @type {Promise<string>|null} In-flight TileJSON resolution, shared by callers. */
let _tileTemplateInFlight = null;

/**
 * Slippy-map tile coordinates for a WGS84 point.
 *
 * @param {number} lat - Latitude (degrees).
 * @param {number} lon - Longitude (degrees).
 * @param {number} z - Zoom level.
 * @returns {[number, number]} `[x, y]` tile indices.
 */
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  );
  return [
    Math.max(0, Math.min(n - 1, x)),
    Math.max(0, Math.min(n - 1, y)),
  ];
}

/**
 * Pick the most detailed zoom whose tile cover fits the fetch budget.
 *
 * The caller's viewport widens with camera altitude, so a fixed zoom would
 * either fetch 50 tiles when zoomed out or lose residential streets when
 * zoomed in. Walking down from z14 keeps detail where it is affordable.
 *
 * @param {{south:number,west:number,north:number,east:number}} bbox
 * @returns {{z:number,x0:number,y0:number,x1:number,y1:number}}
 */
function pickCover({ south, west, north, east }) {
  let fallback = null;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z -= 1) {
    const [x0, y0] = tileXY(north, west, z);
    const [x1, y1] = tileXY(south, east, z);
    const cover = { z, x0, y0, x1, y1 };
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) return cover;
    fallback = cover;
  }
  // Even MIN_ZOOM overflows the budget (a viewport far wider than traffic ever
  // renders). Clamp to the budget around the bbox centre rather than refusing.
  const { z, x0, y0, x1, y1 } = fallback;
  const side = Math.max(1, Math.floor(Math.sqrt(MAX_TILES)));
  const cx = Math.floor((x0 + x1) / 2);
  const cy = Math.floor((y0 + y1) / 2);
  const half = Math.floor(side / 2);
  return {
    z,
    x0: Math.max(x0, cx - half),
    y0: Math.max(y0, cy - half),
    x1: Math.min(x1, cx - half + side - 1),
    y1: Math.min(y1, cy - half + side - 1),
  };
}

/**
 * Resolve the `{z}/{x}/{y}` tile URL template from TileJSON, cached.
 *
 * @returns {Promise<string>} The tile URL template.
 */
async function resolveTileTemplate() {
  const now = Date.now();
  if (_tileTemplate && now - _tileTemplate.at < TILEJSON_TTL_MS)
    return _tileTemplate.template;
  if (_tileTemplateInFlight) return _tileTemplateInFlight;

  _tileTemplateInFlight = (async () => {
    const res = await fetch(TILEJSON_URL, {
      signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`TileJSON ${res.status}`);
    const json = await res.json();
    const template = json?.tiles?.[0];
    if (typeof template !== 'string' || !template.includes('{z}'))
      throw new Error('TileJSON carries no tile template');
    _tileTemplate = { template, at: Date.now() };
    return template;
  })().finally(() => {
    _tileTemplateInFlight = null;
  });

  return _tileTemplateInFlight;
}

/**
 * Fetch and decode one vector tile, memoized.
 *
 * A 204/404 is a legitimately empty tile (ocean, desert), cached as `null` so
 * an empty region is not refetched on every camera move.
 *
 * @param {string} template - Tile URL template.
 * @param {number} z - Zoom.
 * @param {number} x - Tile x.
 * @param {number} y - Tile y.
 * @returns {Promise<Object|null>} Decoded `VectorTile`, or null when empty.
 */
async function loadTile(template, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = _tileCache.get(key);
  if (hit && Date.now() - hit.at < TILE_TTL_MS) return hit.tile;

  const url = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
  });
  if (res.status === 204 || res.status === 404) {
    _tileCache.set(key, { tile: null, at: Date.now() });
    return null;
  }
  if (!res.ok) throw new Error(`Tile ${key} returned ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const tile = buf.byteLength
    ? new VectorTile(new PbfReader(buf))
    : null;
  _tileCache.set(key, { tile, at: Date.now() });
  if (_tileCache.size > TILE_CACHE_MAX) {
    const oldest = _tileCache.keys().next().value;
    _tileCache.delete(oldest);
  }
  return tile;
}

/**
 * Map one transportation feature onto an OSM `highway` value.
 *
 * @param {Object} props - MVT feature properties.
 * @returns {string|null} The `highway` value, or null when it is not a road.
 */
function highwayFor(props) {
  const base = CLASS_TO_HIGHWAY[props?.class];
  if (!base) return null;
  if (props.class === 'minor' && props.subclass)
    return MINOR_SUBCLASS[props.subclass] || base;
  return base;
}

/**
 * Whether a parsed road query should be served from vector tiles.
 *
 * @param {string} formBody - The sanitized `data=`-encoded Overpass form body.
 * @returns {{classes:Set<string>,south:number,west:number,north:number,east:number}|null}
 */
function parseRoadQuery(formBody) {
  if (ROADS_SOURCE !== 'vector-tiles') return null;
  let ql;
  try {
    ql = new URLSearchParams(formBody).get('data');
  } catch {
    return null;
  }
  if (!ql) return null;
  const m = ROAD_QUERY_RE.exec(ql.trim());
  if (!m) return null;
  const [, alternation, s, w, n, e] = m;
  const south = Number(s);
  const west = Number(w);
  const north = Number(n);
  const east = Number(e);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  return {
    classes: new Set(alternation.split('|').filter(Boolean)),
    south,
    west,
    north,
    east,
  };
}

/**
 * Build an Overpass-shaped road payload from vector tiles.
 *
 * Mirrors the return contract of `fetchOverpassPayload` so the caller's cache,
 * request coalescing, stale-serving and rate limiting are reused verbatim.
 *
 * @param {ReturnType<typeof parseRoadQuery>} query - A parsed road query.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string}>}
 */
async function fetchRoadsFromTiles(query) {
  const { classes, south, west, north, east } = query;
  const template = await resolveTileTemplate();
  const cover = pickCover(query);

  const jobs = [];
  for (let x = cover.x0; x <= cover.x1; x += 1)
    for (let y = cover.y0; y <= cover.y1; y += 1)
      jobs.push({ x, y });

  // One dead tile must not empty the viewport — a partial road graph still
  // renders, and the layer's own cache keeps the rest.
  const tiles = await Promise.all(
    jobs.map(async (job) => {
      try {
        return { job, tile: await loadTile(template, cover.z, job.x, job.y) };
      } catch {
        return { job, tile: null };
      }
    }),
  );

  // Pad the keep-test so a road entering the viewport is not dropped for having
  // no vertex strictly inside it. A tile is wider than the viewport at these
  // zooms, so a generous pad buys nothing but payload: the first cut used half
  // the bbox span and kept motorway far outside the camera.
  const padLat = (north - south) * 0.2;
  const padLon = (east - west) * 0.2;
  const inView = ([lon, lat]) =>
    lat >= south - padLat &&
    lat <= north + padLat &&
    lon >= west - padLon &&
    lon <= east + padLon;

  const elements = [];
  let id = 1;
  let truncated = false;

  outer: for (const { job, tile } of tiles) {
    const layer = tile?.layers?.transportation;
    if (!layer) continue;
    for (let i = 0; i < layer.length; i += 1) {
      if (elements.length >= MAX_ELEMENTS) {
        truncated = true;
        break outer;
      }
      const feature = layer.feature(i);
      const highway = highwayFor(feature.properties);
      if (!highway || !classes.has(highway)) continue;

      const geojson = feature.toGeoJSON(job.x, job.y, cover.z);
      const parts =
        geojson.geometry.type === 'MultiLineString'
          ? geojson.geometry.coordinates
          : [geojson.geometry.coordinates];

      for (const line of parts) {
        if (!Array.isArray(line) || line.length < 2) continue;
        if (!line.some(inView)) continue;
        const oneway = feature.properties.oneway;
        elements.push({
          type: 'way',
          id: id++,
          tags: {
            highway,
            ...(oneway === 1 ? { oneway: 'yes' } : {}),
            ...(oneway === -1 ? { oneway: '-1' } : {}),
          },
          geometry: line.map(([lon, lat]) => ({ lat, lon })),
        });
      }
    }
  }

  const body = JSON.stringify({
    version: 0.6,
    generator: 'gods-eye-view roadTiles (OpenMapTiles vector tiles)',
    attribution: ROADS_ATTRIBUTION,
    tiles: { z: cover.z, fetched: jobs.length, truncated },
    elements,
  });

  return {
    status: 200,
    body,
    contentType: 'application/json',
    endpoint: `vector-tiles z${cover.z}`,
  };
}

export {
  ROADS_SOURCE,
  ROADS_ATTRIBUTION,
  parseRoadQuery,
  fetchRoadsFromTiles,
  // Exported for tests.
  pickCover,
  tileXY,
  highwayFor,
};
