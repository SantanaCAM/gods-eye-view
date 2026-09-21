import fs from 'node:fs';
import path from 'node:path';

/**
 * @file ALPR camera locations from the DeFlock bulk dataset, returned in the
 * Overpass JSON shape the ALPR layer already parses.
 *
 * WHY THIS EXISTS (Project Adam / Godseye fork, 2026-09-21). Same root cause as
 * `roadTiles.js`: every full-planet Overpass instance refuses this deployment's
 * WAN address. Measured the same day, `overpass-api.de` escalated from an
 * Apache 406 to refusing the TCP connection outright, while the identical URL
 * fetched from another network returned a healthy `2 slots available now`.
 * The block is on the IP, and no query change reaches past it.
 *
 * The ALPR layer asks Overpass for `man_made=surveillance` +
 * `surveillance:type=ALPR` nodes — the tagging the DeFlock community maintains
 * in OSM. `deflock-data` republishes exactly that set as a single GeoJSON
 * rebuilt from OSM on a schedule, served from Cloudflare with no key and no
 * rate limit beyond the CDN's own. Same data, same licence, a transport that
 * is not blocked.
 *
 * WHY THE BULK FILE AND NOT THE TILES. The same project publishes per-country
 * PMTiles, and tiles were the right answer for roads. Not here: the ALPR layer
 * allows a viewport up to `MAX_VIEWPORT_DEGREES` (3°), and camera properties
 * only exist at tile zooms 11-14, where 3° is ~324 tiles for one query. The
 * whole national dataset is 37 MB and parses in 293 ms, so it is cheaper to
 * hold all of it than to fetch a fraction of it repeatedly — and an in-memory
 * index answers any bbox exactly, with no truncation and no zoom heuristic.
 *
 * The output is Overpass-shaped on purpose, so `normalizeAlprNode` and every
 * client behaviour downstream of it are untouched.
 *
 * Set `GEV_ALPR_SOURCE=overpass` to fall back to the upstream mirrors.
 *
 * @module server/providers/overpass/alprSource
 */

/** ALPR source: 'deflock' (default here) or 'overpass' (upstream mirrors). */
const ALPR_SOURCE = (process.env.GEV_ALPR_SOURCE || 'deflock').toLowerCase();

/** Bulk dataset. Served with `Content-Encoding: gzip`, so fetch decodes it. */
const ALPR_DATASET_URL =
  process.env.GEV_ALPR_DATASET ||
  'https://data.dontgetflocked.com/cameras.geojson.gz';

/** Attribution — the data is OSM's, ODbL 1.0, republished by DeFlock. */
const ALPR_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL 1.0), via the DeFlock community';

/** How long a downloaded dataset is reused before refetching (ms). */
const DATASET_TTL_MS = 24 * 3_600_000;

/** Disk cache, so a service restart does not re-download 37 MB. */
const DATASET_DIR = path.join(process.cwd(), '.gev-cache', 'alpr');
const DATASET_FILE = path.join(DATASET_DIR, 'cameras.geojson');

/** Download timeout (ms). The file is large but the CDN is fast (~0.6 s). */
const DATASET_TIMEOUT_MS = 90_000;

/** Grid cell size in degrees for the bbox index. */
const CELL_DEG = 0.25;

/**
 * The exact query `buildOverpassQuery` emits in `src/layers/alpr/records.js`,
 * optionally carrying the brand filter the Flock layer adds. Matching narrowly
 * is the point: every other Overpass query must still reach the mirrors.
 */
const ALPR_QUERY_RE =
  /^\[out:json\]\[timeout:\d+\];\s*node\["man_made"="surveillance"\]\["surveillance:type"~"\(\^\|;\)\\s\*ALPR\\s\*\(;\|\$\)",i\](?:\["brand"~"([^"]*)",i\])?\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*;\s*out body (\d+);\s*$/;

/** @type {{count:number, lats:Float64Array, lons:Float64Array, ids:Float64Array, dirs:Float64Array, brandIdx:Int32Array, operIdx:Int32Array, zoneIdx:Int32Array, refs:Array<string|null>, brands:string[], opers:string[], zones:string[], grid:Map<string,number[]>, at:number}|null} */
let _dataset = null;

/** @type {Promise<Object>|null} In-flight load, shared by concurrent callers. */
let _loading = null;

/** Grid key for a coordinate. */
function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
}

/**
 * Read the dataset from disk if it is fresh, else download and cache it.
 *
 * @returns {Promise<string>} Raw GeoJSON text.
 */
async function readDatasetText() {
  try {
    const stat = fs.statSync(DATASET_FILE);
    if (Date.now() - stat.mtimeMs < DATASET_TTL_MS)
      return fs.readFileSync(DATASET_FILE, 'utf8');
  } catch {
    /* no cache yet */
  }

  const res = await fetch(ALPR_DATASET_URL, {
    signal: AbortSignal.timeout(DATASET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ALPR dataset ${res.status}`);
  const text = await res.text();
  // A truncated download must not become an authoritative empty map.
  if (text.length < 1_000_000 || !text.includes('"features"'))
    throw new Error('ALPR dataset looks truncated');

  try {
    fs.mkdirSync(DATASET_DIR, { recursive: true });
    fs.writeFileSync(DATASET_FILE, text);
  } catch {
    /* cache is an optimization, not a requirement */
  }
  return text;
}

/**
 * Build the compact in-memory index.
 *
 * The parsed GeoJSON retains ~149 MB of heap; the typed-array form is a few MB
 * and is what is kept, so the object graph is dropped as soon as this returns.
 *
 * @returns {Promise<Object>} The dataset index.
 */
async function loadDataset() {
  if (_dataset && Date.now() - _dataset.at < DATASET_TTL_MS) return _dataset;
  if (_loading) return _loading;

  _loading = (async () => {
    const parsed = JSON.parse(await readDatasetText());
    const features = Array.isArray(parsed?.features) ? parsed.features : [];
    const n = features.length;
    if (!n) throw new Error('ALPR dataset carries no features');

    const lats = new Float64Array(n);
    const lons = new Float64Array(n);
    const ids = new Float64Array(n);
    const dirs = new Float64Array(n);
    const brandIdx = new Int32Array(n);
    const operIdx = new Int32Array(n);
    const zoneIdx = new Int32Array(n);
    const refs = new Array(n);
    const brands = [];
    const opers = [];
    const zones = [];
    const brandMap = new Map();
    const operMap = new Map();
    const zoneMap = new Map();
    const grid = new Map();

    const intern = (value, table, map) => {
      if (value == null || value === '') return -1;
      const key = String(value);
      let at = map.get(key);
      if (at === undefined) {
        at = table.length;
        table.push(key);
        map.set(key, at);
      }
      return at;
    };

    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const feature = features[i];
      const coords = feature?.geometry?.coordinates;
      const props = feature?.properties;
      if (!Array.isArray(coords) || !props) continue;
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      const id = Number(props.osmId);
      // The client drops anything whose id is not a positive safe integer, so
      // filtering here keeps the emitted payload honest about its own count.
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180 ||
        !Number.isSafeInteger(id) ||
        id <= 0
      )
        continue;

      const at = count++;
      lats[at] = lat;
      lons[at] = lon;
      ids[at] = id;
      const dir = Number(props.direction);
      dirs[at] = Number.isFinite(dir) ? dir : Number.NaN;
      brandIdx[at] = intern(props.brand, brands, brandMap);
      operIdx[at] = intern(props.operator, opers, operMap);
      zoneIdx[at] = intern(props.surveillanceZone, zones, zoneMap);
      refs[at] = props.ref == null ? null : String(props.ref);

      const key = cellKey(lat, lon);
      const bucket = grid.get(key);
      if (bucket) bucket.push(at);
      else grid.set(key, [at]);
    }

    _dataset = {
      count,
      lats,
      lons,
      ids,
      dirs,
      brandIdx,
      operIdx,
      zoneIdx,
      refs,
      brands,
      opers,
      zones,
      grid,
      at: Date.now(),
    };
    return _dataset;
  })().finally(() => {
    _loading = null;
  });

  return _loading;
}

/**
 * Whether a parsed ALPR query should be served from the DeFlock dataset.
 *
 * @param {string} formBody - The sanitized `data=`-encoded Overpass form body.
 * @returns {{south:number,west:number,north:number,east:number,brand:string|null,limit:number}|null}
 */
function parseAlprQuery(formBody) {
  if (ALPR_SOURCE !== 'deflock') return null;
  let ql;
  try {
    ql = new URLSearchParams(formBody).get('data');
  } catch {
    return null;
  }
  if (!ql) return null;
  const m = ALPR_QUERY_RE.exec(ql.trim());
  if (!m) return null;
  const [, brand, s, w, n, e, limit] = m;
  const south = Number(s);
  const west = Number(w);
  const north = Number(n);
  const east = Number(e);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  return {
    south,
    west,
    north,
    east,
    brand: brand || null,
    limit: Math.max(1, Math.min(10_000, Number(limit) || 1500)),
  };
}

/**
 * Build an Overpass-shaped ALPR payload from the in-memory dataset.
 *
 * Mirrors the return contract of `fetchOverpassPayload` so the caller's cache,
 * request coalescing, stale-serving and rate limiting are reused verbatim.
 *
 * @param {ReturnType<typeof parseAlprQuery>} query - A parsed ALPR query.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string}>}
 */
async function fetchAlprFromDataset(query) {
  const data = await loadDataset();
  const { south, west, north, east, brand, limit } = query;

  // Resolve the brand filter against the string table once, not per camera.
  // The table is a few hundred entries; the dataset is ~143,000 cameras.
  let allowedBrands = null;
  if (brand) {
    let re;
    try {
      re = new RegExp(brand, 'i');
    } catch {
      re = null;
    }
    allowedBrands = new Set();
    for (let i = 0; i < data.brands.length; i += 1) {
      const name = data.brands[i];
      if (re ? re.test(name) : name.toLowerCase().includes(brand.toLowerCase()))
        allowedBrands.add(i);
    }
  }

  const elements = [];
  let truncated = false;
  const cellSouth = Math.floor(south / CELL_DEG);
  const cellNorth = Math.floor(north / CELL_DEG);
  const cellWest = Math.floor(west / CELL_DEG);
  const cellEast = Math.floor(east / CELL_DEG);

  outer: for (let cy = cellSouth; cy <= cellNorth; cy += 1) {
    for (let cx = cellWest; cx <= cellEast; cx += 1) {
      const bucket = data.grid.get(`${cy}:${cx}`);
      if (!bucket) continue;
      for (const at of bucket) {
        const lat = data.lats[at];
        const lon = data.lons[at];
        if (lat < south || lat > north || lon < west || lon > east) continue;
        if (allowedBrands && !allowedBrands.has(data.brandIdx[at])) continue;
        if (elements.length >= limit) {
          truncated = true;
          break outer;
        }

        const tags = {
          man_made: 'surveillance',
          // The dataset IS the ALPR selection, so this tag is definitional
          // rather than copied — the client re-checks it before accepting a
          // node, and would drop every camera without it.
          'surveillance:type': 'ALPR',
        };
        const brandName =
          data.brandIdx[at] >= 0 ? data.brands[data.brandIdx[at]] : null;
        if (brandName) {
          // `manufacturer` is what normalizeAlprNode reads; `brand` is what the
          // source data calls it. Emit both so neither reader is surprised.
          tags.manufacturer = brandName;
          tags.brand = brandName;
        }
        if (data.operIdx[at] >= 0) tags.operator = data.opers[data.operIdx[at]];
        if (data.zoneIdx[at] >= 0)
          tags['surveillance:zone'] = data.zones[data.zoneIdx[at]];
        if (Number.isFinite(data.dirs[at]))
          tags.direction = String(data.dirs[at]);
        if (data.refs[at]) tags.ref = data.refs[at];

        elements.push({
          type: 'node',
          id: data.ids[at],
          lat,
          lon,
          tags,
        });
      }
    }
  }

  const body = JSON.stringify({
    version: 0.6,
    generator: 'gods-eye-view alprSource (DeFlock bulk dataset)',
    attribution: ALPR_ATTRIBUTION,
    alpr: {
      datasetCameras: data.count,
      returned: elements.length,
      truncated,
      brandFilter: brand || null,
    },
    elements,
  });

  return {
    status: 200,
    body,
    contentType: 'application/json',
    endpoint: brand ? `deflock (brand~${brand})` : 'deflock',
  };
}

export {
  ALPR_SOURCE,
  ALPR_ATTRIBUTION,
  parseAlprQuery,
  fetchAlprFromDataset,
  // Exported for tests.
  loadDataset,
  cellKey,
};
