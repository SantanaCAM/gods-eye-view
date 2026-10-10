import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createIonImagery } from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';
import { createDefaultMapSources } from './defaultSources.js';

test('Esri uses Re:Earth without keys and preserves ion terrain when configured', async () => {
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const originalResource = Cesium.IonResource.fromAssetId;
  const calls = [];
  try {
    Cesium.CesiumTerrainProvider.fromUrl = async (resource) => {
      calls.push(resource);
      return { resource };
    };
    Cesium.IonResource.fromAssetId = async () =>
      assert.fail('keyless mode must not acquire ion terrain');
    const keyless = createDefaultMapSources();
    const esri = keyless.sources.find(
      ({ descriptor }) => descriptor.id === 'esri-imagery',
    );
    assert.equal(esri.available, true);
    assert.equal(esri.terrain.id, 'keyless');
    assert.equal(esri.terrain.create, createKeylessTerrain);
    await esri.terrain.create();
    // A Resource, not a bare URL: the retry policy rides on it (terrainRetry.js).
    assert.equal(calls.length, 1);
    assert.ok(calls[0] instanceof Cesium.Resource);
    assert.equal(
      calls[0].url,
      'https://terrain.reearth.land/cesium-mesh/ellipsoid',
    );
    assert.equal(calls[0].retryAttempts, 3);
    assert.equal(typeof calls[0].retryCallback, 'function');
    assert.equal(
      keyless.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
        .available,
      false,
    );
    for (const credentials of [
      { googleApiKey: 'test-key' },
      { cesiumToken: 'test-token' },
    ]) {
      const keyed = createDefaultMapSources({
        ...credentials,
        googleTileset: { show: true },
      });
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'photoreal')
          .available,
        true,
      );
      assert.equal(
        keyed.sources.find(({ descriptor }) => descriptor.id === 'esri-imagery')
          .terrain.id,
        credentials.cesiumToken ? 'world' : 'keyless',
      );
      const failedTileset = createDefaultMapSources(credentials);
      assert.equal(
        failedTileset.sources.find(
          ({ descriptor }) => descriptor.id === 'photoreal',
        ).available,
        false,
      );
    }
  } finally {
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
    Cesium.IonResource.fromAssetId = originalResource;
  }
});

test('imagery and terrain pass their own ion token without relying on SDK defaults', async () => {
  const originalImagery = Cesium.IonImageryProvider.fromAssetId;
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const calls = [];
  const defaultToken = Cesium.Ion.defaultAccessToken;
  try {
    Cesium.IonImageryProvider.fromAssetId = async (id, options) => {
      calls.push({ kind: 'imagery', id, options });
      return { id };
    };
    Cesium.IonResource.fromAssetId = async (id, options) => {
      calls.push({ kind: 'resource', id, options });
      return { id };
    };
    Cesium.CesiumTerrainProvider.fromUrl = async (resource, options) => {
      calls.push({ kind: 'terrain', resource, options });
      return { id: 'terrain' };
    };
    await createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, 'imagery-token');
    const result = await createWorldTerrain('terrain-token');
    assert.equal(calls[0].options.accessToken, 'imagery-token');
    assert.equal(calls[1].options.accessToken, 'terrain-token');
    assert.equal(calls[1].id, 1);
    assert.equal(calls[2].options.requestVertexNormals, true);
    assert.equal(result.provider.id, 'terrain');
    assert.equal(Cesium.Ion.defaultAccessToken, defaultToken);
  } finally {
    Cesium.IonImageryProvider.fromAssetId = originalImagery;
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('cancellation after ion metadata prevents terrain construction', async () => {
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const controller = new AbortController();
  try {
    Cesium.IonResource.fromAssetId = async () => {
      controller.abort();
      return {};
    };
    Cesium.CesiumTerrainProvider.fromUrl = () =>
      assert.fail('cancelled terrain construction');
    await assert.rejects(
      createWorldTerrain('test-token', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('credentialed source factories reject an omitted token instead of consuming an SDK default', async () => {
  assert.throws(
    () => createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, ''),
    /explicit token/,
  );
  await assert.rejects(createWorldTerrain(' '), /explicit ion token/);
});

test('both Google 3D routes keep tiles drawing while draped imagery loads', async () => {
  const { createGoogleDirectTileset, createGoogleIonTileset } =
    await import('./google3d.js');
  const calls = [];
  const sdk = {
    createGooglePhotorealistic3DTileset: async (...args) => {
      calls.push(args);
      return 'direct';
    },
    IonResource: { fromAssetId: async (id, options) => ({ id, ...options }) },
    Cesium3DTileset: {
      fromUrl: async (...args) => {
        calls.push(args);
        return 'ion';
      },
    },
  };
  assert.equal(await createGoogleDirectTileset(sdk, 'key'), 'direct');
  assert.equal(await createGoogleIonTileset(sdk, 'token'), 'ion');
  assert.deepEqual(calls[0], [
    { key: 'key', onlyUsingWithGoogleGeocoder: true },
    { asynchronouslyLoadImagery: true },
  ]);
  assert.equal(calls[1][0].id, 2275207);
  assert.equal(calls[1][0].accessToken, 'token');
  assert.equal(calls[1][1].asynchronouslyLoadImagery, true);
  assert.equal(calls[1][1].enableCollision, true);
});

test('an http page gets Bing tiles over https, so the CSP does not blank the globe', async () => {
  const originalImagery = Cesium.IonImageryProvider.fromAssetId;
  const originalBing = Cesium.BingMapsImageryProvider.fromUrl;
  const originalFetch = Cesium.Resource.prototype.fetchJson;
  const calls = [];
  let endpoint = {
    type: 'IMAGERY',
    externalType: 'BING',
    options: {
      url: 'https://dev.virtualearth.net',
      key: 'k',
      mapStyle: 'Aerial',
    },
  };
  try {
    Cesium.Resource.prototype.fetchJson = async function () {
      calls.push({ kind: 'endpoint', url: this.url });
      return endpoint;
    };
    Cesium.BingMapsImageryProvider.fromUrl = async (url, options) => {
      calls.push({ kind: 'bing', url, options });
      return { bing: true };
    };
    Cesium.IonImageryProvider.fromAssetId = async (id, options) => {
      calls.push({ kind: 'ion', id, options });
      return { ion: true };
    };

    const style = Cesium.IonWorldImageryStyle.AERIAL;
    assert.deepEqual(
      await createIonImagery(style, 't', { protocol: 'http:' }),
      { bing: true },
    );
    assert.match(calls[0].url, /v1\/assets\/2\/endpoint\?access_token=t/);
    assert.equal(calls[1].url, 'https://dev.virtualearth.net');
    assert.deepEqual(calls[1].options, {
      key: 'k',
      mapStyle: 'Aerial',
      tileProtocol: 'https',
    });

    // An https page keeps Cesium's own ion path and never fetches the endpoint itself.
    calls.length = 0;
    assert.deepEqual(
      await createIonImagery(style, 't', { protocol: 'https:' }),
      { ion: true },
    );
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      ['ion'],
    );

    // A non-Bing ion imagery asset on an http page still goes through ion.
    calls.length = 0;
    endpoint = {
      type: 'IMAGERY',
      externalType: 'TMS',
      options: { url: 'https://x' },
    };
    assert.deepEqual(
      await createIonImagery(style, 't', { protocol: 'http:' }),
      { ion: true },
    );
    assert.deepEqual(
      calls.map(({ kind }) => kind),
      ['endpoint', 'ion'],
    );
  } finally {
    Cesium.IonImageryProvider.fromAssetId = originalImagery;
    Cesium.BingMapsImageryProvider.fromUrl = originalBing;
    Cesium.Resource.prototype.fetchJson = originalFetch;
  }
});
