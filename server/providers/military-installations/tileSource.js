import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

/**
 * @file Military land extents from OpenMapTiles-schema vector tiles, returned
 * in the Overpass JSON shape `normalizeMilitaryInstallations` already parses.
 *
 * WHY THIS EXISTS (Project Adam / Godseye fork, 2026-09-21). Third layer felled
 * by the same cause: every full-planet Overpass instance refuses this
 * deployment's WAN address, and this provider called `fetchOverpassPayload`
 * directly rather than through `/api/overpass`, so neither earlier fix reached
 * it. Symptom was a 503 after ~45 s of mirror timeouts.
 *
 * WHAT THIS DOES NOT RECOVER — READ BEFORE "IMPROVING" IT. The OpenMapTiles
 * `landuse` layer carries **`class` and nothing else**: there is no `name`
 * field, and the `poi` layer holds no military-base entries (checked over
 * Travis AFB and Beale AFB — the only military-ish POI at either is a shop,
 * "Travis AFB Main Exchange"). So installations render with correct extents and
 * a **generic label**, not their real names.
 *
 * That is a deliberate, honest downgrade rather than a fabrication: the layer
 * already has a designed path for unnamed features (`humanizeInstallationClass`,
 * added after an owner playtest on 2026-08-18 when the old fallback showed an
 * OSM primary key as if it were a place name). A base reads as its class, and
 * the real OSM id is preserved on `id` and in `sources[]`, so nothing claims a
 * name it does not have.
 *
 * The `military=airfield|naval_base|range|barracks` distinctions are likewise
 * NOT recoverable here — the schema has one `military` landuse class — so every
 * record arrives as `military_land`.
 *
 * Set `GEV_INSTALLATIONS_SOURCE=overpass` to fall back to the mirrors.
 *
 * @module server/providers/military-installations/tileSource
 */

/** Source: 'tiles' (default here) or 'overpass' (upstream mirrors). */
const INSTALLATIONS_SOURCE = (
  process.env.GEV_INSTALLATIONS_SOURCE || 'tiles'
).toLowerCase();

/** TileJSON endpoint — resolved, not hardcoded; the build path rolls forward. */
const TILEJSON_URL =
  process.env.GEV_ROADS_TILEJSON || 'https://tiles.openfreemap.org/planet';

const TILEJSON_TTL_MS = 6 * 3_600_000;
const TILE_TTL_MS = 24 * 3_600_000;
const TILE_CACHE_MAX = 192;
const MAX_TILES = 12;
const MIN_ZOOM = 10;
const MAX_ZOOM = 13;
const TILE_TIMEOUT_MS = 12_000;

/** Matches MAX_FOOTPRINT_POINTS in src/data/militaryInstallationData.js. */
const MAX_FOOTPRINT_POINTS = 400;

/** @type {Map<string,{tile:Object|null,at:number}>} */
const _tileCache = new Map();
let _tileTemplate = null;
let _tileTemplateInFlight = null;

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = (clamped * Math.PI) / 180;
  return [
    Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n))),
    Math.max(
      0,
      Math.min(
        n - 1,
        Math.floor(
          ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
        ),
      ),
    ),
  ];
}

/** Most detailed zoom whose tile cover fits the fetch budget. */
function pickCover({ south, west, north, east }) {
  let fallback = null;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z -= 1) {
    const [x0, y0] = tileXY(north, west, z);
    const [x1, y1] = tileXY(south, east, z);
    const cover = { z, x0, y0, x1, y1 };
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) return cover;
    fallback = cover;
  }
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

async function loadTile(template, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = _tileCache.get(key);
  if (hit && Date.now() - hit.at < TILE_TTL_MS) return hit.tile;
  const url = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  const res = await fetch(url, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) });
  if (res.status === 204 || res.status === 404) {
    _tileCache.set(key, { tile: null, at: Date.now() });
    return null;
  }
  if (!res.ok) throw new Error(`Tile ${key} returned ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const tile = buf.byteLength ? new VectorTile(new PbfReader(buf)) : null;
  _tileCache.set(key, { tile, at: Date.now() });
  if (_tileCache.size > TILE_CACHE_MAX)
    _tileCache.delete(_tileCache.keys().next().value);
  return tile;
}

/** Every outer ring of a polygon or multipolygon GeoJSON geometry. */
function outerRings(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry?.type === 'MultiPolygon')
    return geometry.coordinates.map((polygon) => polygon[0]);
  return [];
}

/** Sub-sample a ring that exceeds the client's footprint cap, keeping closure. */
function fitRing(ring) {
  if (ring.length <= MAX_FOOTPRINT_POINTS) return ring;
  const step = Math.ceil(ring.length / (MAX_FOOTPRINT_POINTS - 1));
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  if (out[out.length - 1] !== ring[ring.length - 1])
    out.push(ring[ring.length - 1]);
  return out;
}

/**
 * Build an Overpass-shaped military-installation payload from vector tiles.
 *
 * @param {{south:number,west:number,north:number,east:number}} box
 * @param {number} cap - Max elements, from MILITARY_INSTALLATION_ELEMENT_CAP.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string}>}
 */
async function fetchInstallationsFromTiles(box, cap = 700) {
  const template = await resolveTileTemplate();
  const cover = pickCover(box);

  const jobs = [];
  for (let x = cover.x0; x <= cover.x1; x += 1)
    for (let y = cover.y0; y <= cover.y1; y += 1) jobs.push({ x, y });

  const tiles = await Promise.all(
    jobs.map(async (job) => {
      try {
        return { job, tile: await loadTile(template, cover.z, job.x, job.y) };
      } catch {
        // One dead tile must not empty the viewport.
        return { job, tile: null };
      }
    }),
  );

  /**
   * A base wider than a tile arrives as several CLIPPED fragments sharing one
   * OSM id (verified over Travis AFB: id 440187402 in tiles 660/1576 and
   * 661/1576). The client drops duplicate ids, so they are merged here rather
   * than emitted separately: bounds span every fragment, and the footprint is
   * the fragment with the most vertices. The id stays the real OSM one, so
   * `sources[]` never cites a way that does not exist.
   * @type {Map<number, {ring:number[][], bounds:number[]}>}
   */
  const byId = new Map();

  for (const { job, tile } of tiles) {
    const layer = tile?.layers?.landuse;
    if (!layer) continue;
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i);
      if (feature.properties?.class !== 'military') continue;
      const osmId = Number(feature.id);
      if (!Number.isSafeInteger(osmId) || osmId <= 0) continue;

      const geojson = feature.toGeoJSON(job.x, job.y, cover.z);
      for (const ring of outerRings(geojson.geometry)) {
        if (!Array.isArray(ring) || ring.length < 4) continue;
        let [minLon, minLat, maxLon, maxLat] = [
          Infinity,
          Infinity,
          -Infinity,
          -Infinity,
        ];
        for (const [lon, lat] of ring) {
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) continue;

        const existing = byId.get(osmId);
        if (!existing) {
          byId.set(osmId, { ring, bounds: [minLat, minLon, maxLat, maxLon] });
          continue;
        }
        const b = existing.bounds;
        existing.bounds = [
          Math.min(b[0], minLat),
          Math.min(b[1], minLon),
          Math.max(b[2], maxLat),
          Math.max(b[3], maxLon),
        ];
        if (ring.length > existing.ring.length) existing.ring = ring;
      }
    }
  }

  const elements = [];
  let truncated = false;
  for (const [osmId, entry] of byId) {
    if (elements.length >= cap) {
      truncated = true;
      break;
    }
    const [minlat, minlon, maxlat, maxlon] = entry.bounds;
    const ring = fitRing(entry.ring);
    elements.push({
      type: 'way',
      id: osmId,
      // The schema collapses every military landuse into one class, so this is
      // the only tag that can honestly be asserted. No `military=` subtype is
      // invented, and no `name` is invented either.
      tags: { landuse: 'military' },
      center: { lat: (minlat + maxlat) / 2, lon: (minlon + maxlon) / 2 },
      bounds: { minlat, minlon, maxlat, maxlon },
      geometry: ring.map(([lon, lat]) => ({ lat, lon })),
    });
  }

  return {
    status: 200,
    body: JSON.stringify({
      version: 0.6,
      generator:
        'gods-eye-view installationTiles (OpenMapTiles vector tiles, extents only)',
      installations: {
        zoom: cover.z,
        tilesFetched: jobs.length,
        merged: byId.size,
        truncated,
      },
      elements,
    }),
    contentType: 'application/json',
    endpoint: `vector-tiles z${cover.z}`,
  };
}

export {
  INSTALLATIONS_SOURCE,
  fetchInstallationsFromTiles,
  // Exported for tests.
  pickCover,
  tileXY,
  fitRing,
};
