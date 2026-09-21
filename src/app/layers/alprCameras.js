import { createAlprCamerasLayer } from '../../layers/alpr/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { registerWorldOverlayPaintLane } from '../../overlays/worldOverlay.js';
import { keyholeLabelAlphaFromGeometry } from '../../celestialRing.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/**
 * Construct one layer using the application scene owners and a supplied source.
 *
 * Called TWICE — once for all mapped ALPR cameras and once for the Flock-only
 * view — so the identity is a parameter, not a constant. Omitting it yields the
 * all-brands layer, which is what every existing caller wants.
 */
export function createApplicationAlpr({
  surface,
  source,
  layerId,
  layerName,
  icon,
}) {
  const { groundFloor } = surface;
  return createAlprCamerasLayer({
    source,
    ...(layerId ? { layerId } : {}),
    ...(layerName ? { layerName } : {}),
    ...(icon ? { icon } : {}),
    services: {
      render,
      context,
      picking,
      groundFloor,
      overlays: {
        registerPaintLane: registerWorldOverlayPaintLane,
        keyholeAlpha: keyholeLabelAlphaFromGeometry,
        refreshReadout: refreshTrackedReadout,
        subscribeMapStack(callback) {
          window.addEventListener('gev:map-stack-changed', callback);
          return () =>
            window.removeEventListener('gev:map-stack-changed', callback);
        },
      },
    },
  });
}
