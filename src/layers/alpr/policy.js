/**
 * @file Community-mapped automatic license plate reader (ALPR) camera layer.
 *
 * Data source: OpenStreetMap contributors, including the DeFlock community
 * (`man_made=surveillance` + `surveillance:type=ALPR`) — see
 * https://wiki.openstreetmap.org/wiki/Tag:surveillance:type=ALPR and
 * https://deflock.org. OSM data remains ODbL 1.0, separate from the MIT code.
 * Fetched viewport-bounded through the existing generic
 * `/api/overpass` proxy (same one `traffic.js` and `militaryInstallations.js`
 * use) — no new server route needed for a single narrow tag pair.
 *
 * This is mapped surveillance infrastructure, not a live camera feed: no
 * plate records, no vendor accounts, nothing beyond what a contributor chose
 * to publish to OSM. Coverage and tag accuracy are not guaranteed.
 *
 * @module data/alprCameras
 */

export const LAYER_ID = 'alpr-cameras';

/**
 * The Flock-only sibling layer. It is a SECOND INSTANCE of this same layer,
 * differing only in the brand filter it sends and the ids it stamps on its
 * records — not a copy of the code.
 *
 * Its record ids must not collide with the all-brands layer's, because a Flock
 * camera appears in BOTH and the pick registry is keyed by entity id; with both
 * toggles on, a shared prefix would register the same entity twice. Hence the
 * separate prefix below.
 */
export const FLOCK_LAYER_ID = 'flock-devices';

/** Record id prefix for the Flock layer — see FLOCK_LAYER_ID. */
export const FLOCK_ID_PREFIX = 'flock';

/**
 * Brand match for the Flock layer, sent as a case-insensitive Overpass regex.
 *
 * NOT an exact `= 'Flock Safety'`. The OSM data carries at least fourteen
 * spellings of this operator — `FlockSafety`, `flock`, `Flock Group Inc.`,
 * `Flock Safety;Motorola Solutions`, `FLOCK SAFETY` among them. Measured
 * 2026-09-21 against the national dataset: an exact match returns 114,460
 * cameras and this pattern returns 114,560, so being strict would silently
 * drop 100 real ones.
 */
export const FLOCK_BRAND_PATTERN = 'flock';

export const OVERPASS_URL = '/api/overpass';

export const REQUEST_DEBOUNCE_MS = 500;

/** Keep public Overpass queries city-scale, never globe-wide. */
export const MAX_VIEWPORT_DEGREES = 3;

/** Overpass `out body N;` cap — also detects possibly truncated coverage. */
export const QUERY_LIMIT = 1500;

/** Render cap. Kept at or above QUERY_LIMIT on purpose: if it ever sat below
 * it, cameras between the two would be silently dropped while `saturated`
 * stayed false and `count` still reported them — a lie about coverage. */
export const MAX_RENDERED = 1500;

/** Meters — illustrative facing wedge depth, when a camera reports a bearing. */
export const DIRECTION_CONE_M = 90;
export const DIRECTION_CONE_HALF_ANGLE_DEG = 20;

export const EARTH_MEAN_RADIUS_M = 6371008.8;

/** Query boxes are snapped outward to this grid so nearby camera moves reuse
 * one Overpass request body (the shared proxy keys its cache and in-flight
 * dedupe by the exact body) instead of each becoming a distinct upstream fetch. */
export const QUERY_SNAP_DEGREES = 0.05;

/** A view still fully inside the last snapped query box reuses those records
 * for this long before asking Overpass again. */
export const QUERY_REUSE_MS = 10 * 60 * 1000;

/** Vendor-neutral camera badge palette, with coral selection. */
export const ALPR_COLOR = '#52d4ff';
export const ALPR_SELECTED_COLOR = '#ff6474';
export const MARKER_ICON_SIZE = 38;
export const SELECTED_MARKER_ICON_SIZE = 60;
export const MAX_CANVAS_FRUSTUMS = 64;

/** OSM attribution may collapse after five seconds; full credit stays in Data attribution. */
export const CREDIT_DISPLAY_MS = 5000;
