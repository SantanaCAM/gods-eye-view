import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

/**
 * Cesium's ion Bing factory takes the tile scheme from the page, so an app
 * served over plain http asks for http:// Bing tiles — which BROWSER_CSP
 * (img-src https: only) blocks, leaving a bare blue globe. On an http page,
 * resolve the ion endpoint here and build the Bing provider with https tiles.
 * Every other case goes through ion unchanged. (Fork fix, 2026-10-10.)
 */
export function createIonImagery(
  style,
  accessToken,
  { protocol = globalThis.document?.location?.protocol } = {},
) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  if (protocol === 'http:')
    return createIonImageryForHttpPage(style, accessToken);
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

async function createIonImageryForHttpPage(style, accessToken) {
  const endpoint = await Cesium.Ion.defaultServer
    .getDerivedResource({
      url: `v1/assets/${style}/endpoint`,
      queryParameters: { access_token: accessToken },
    })
    .fetchJson();
  if (endpoint?.externalType !== 'BING')
    return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
  const { url, ...options } = endpoint.options;
  return Cesium.BingMapsImageryProvider.fromUrl(url, {
    ...options,
    tileProtocol: 'https',
  });
}
