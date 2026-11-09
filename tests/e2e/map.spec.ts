import { expect, test, type Page } from '@playwright/test';

/**
 * Deterministic local fixture matching OpenFreeMap Liberty layer hierarchy and symbol layers,
 * using an inline GeoJSON source so automated E2E tests never depend on external network availability.
 */
const LIBERTY_STYLE_FIXTURE = {
  version: 8,
  name: 'OpenFreeMap Liberty Fixture',
  sources: {
    openmaptiles: {
      type: 'geojson',
      attribution:
        '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0b1220' },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      paint: { 'fill-color': '#0f2922' },
    },
    {
      id: 'landuse_residential',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      paint: { 'fill-color': '#111827' },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: { 'fill-color': '#091526' },
    },
    {
      id: 'landcover_sand',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      paint: { 'fill-color': '#1f2937' },
    },
    {
      id: 'aeroway_fill',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'aeroway',
      paint: { 'fill-color': '#334155' },
    },
    {
      id: 'tunnel_motorway_link_casing',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      paint: { 'line-color': '#475569' },
    },
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      paint: { 'fill-extrusion-color': '#1e293b' },
    },
    {
      id: 'boundary_2',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      paint: { 'line-color': '#64748b' },
    },
    {
      id: 'road_one_way_arrow',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      layout: {},
    },
    {
      id: 'highway-shield-non-us',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      layout: {
        'text-field': '{ref}',
      },
    },
    {
      id: 'housenumber',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'housenumber',
      layout: {
        'text-field': '{housenumber}',
      },
    },
    {
      id: 'water_name_line',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      },
    },
    {
      id: 'highway_name_other',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      },
    },
    {
      id: 'poi_r1',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      },
    },
    {
      id: 'label_city',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      },
    },
    {
      id: 'label_country_1',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      layout: {
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
      },
    },
  ],
};

async function stubExternalServices(page: Page) {
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/styles/liberty')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LIBERTY_STYLE_FIXTURE),
      });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  });

  await page.route('https://nominatim.openstreetmap.org/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        osm_type: 'relation',
        osm_id: 999,
        lat: '43.2',
        lon: '76.9',
        name: 'Алматы',
        display_name: 'Алматы, Казахстан',
        addresstype: 'city',
        type: 'administrative',
        address: { city: 'Алматы', country_code: 'kz' },
        namedetails: { 'name:ru': 'Алматы' },
      }),
    });
  });
}

async function waitForMapReady(page: Page) {
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready', {
    timeout: 15000,
  });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="travel-map"]') as
      | (HTMLElement & { __travelMap?: { isStyleLoaded: () => boolean } })
      | null;
    const map = el?.__travelMap;
    return Boolean(map && map.isStyleLoaded());
  });
}

test('configures globe interpolation, layer order and Russian labels at three zoom values without recreating canvas', async ({
  page,
}) => {
  await stubExternalServices(page);
  await page.goto('/');
  await waitForMapReady(page);


  // Color France and wait for state commit so we can verify paint preservation across projection transition
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await page.getByLabel('Страна или город', { exact: true }).fill('Франция');
  await page.getByRole('button', { name: 'Франция', exact: true }).click();
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отмечено', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть страну' }).click();

  const inspection = await page.evaluate(async () => {
    const root = document.querySelector('[data-testid="travel-map"]') as HTMLElement & {
      __travelMap: any;
    };
    const map = root.__travelMap;
    const canvasBefore = map.getCanvas();

    map.jumpTo({ center: [20, 20], zoom: 1.8 });
    const initialZoom = map.getZoom();
    const projectionSpec = map.getProjection();

    const styleLayers: string[] = map.getStyle().layers.map((l: { id: string }) => l.id);

    const russianLayers = [
      'water_name_line',
      'highway_name_other',
      'poi_r1',
      'label_city',
      'label_country_1',
    ].map((id) => ({
      id,
      textField: map.getLayoutProperty(id, 'text-field'),
    }));

    const technicalLayers = {
      shield: map.getLayoutProperty('highway-shield-non-us', 'text-field'),
      housenumber: map.getLayoutProperty('housenumber', 'text-field'),
    };

    const zoomSnapshots: number[] = [];
    for (const targetZoom of [4.8, 5.5, 6.2]) {
      map.jumpTo({ zoom: targetZoom });
      zoomSnapshots.push(Number(map.getZoom().toFixed(1)));
    }

    const canvasAfter = map.getCanvas();
    const fillColorAfter = map.getPaintProperty('travel-countries-fill', 'fill-color');

    return {
      initialZoom,
      projectionSpec,
      styleLayers,
      russianLayers,
      technicalLayers,
      zoomSnapshots,
      sameCanvas: canvasBefore === canvasAfter,
      fillColorAfter,
    };
  });

  expect(inspection.initialZoom).toBeLessThan(5);
  expect(inspection.projectionSpec).toEqual({
    type: ['interpolate', ['linear'], ['zoom'], 5, 'vertical-perspective', 6, 'mercator'],
  });
  expect(inspection.zoomSnapshots).toEqual([4.8, 5.5, 6.2]);
  expect(inspection.sameCanvas).toBe(true);
  expect(JSON.stringify(inspection.fillColorAfter)).toContain('#C45B3D');

  // Verify layer ordering: above water/landcover_sand and below aeroway_fill / transportation / building / boundary / labels
  const { styleLayers } = inspection;
  const sandIdx = styleLayers.indexOf('landcover_sand');
  const hitIdx = styleLayers.indexOf('travel-countries-hit');
  const fillIdx = styleLayers.indexOf('travel-countries-fill');
  const outlineIdx = styleLayers.indexOf('travel-countries-outline');
  const selectedFillIdx = styleLayers.indexOf('travel-countries-selected-fill');
  const selectedOutlineIdx = styleLayers.indexOf('travel-countries-selected-outline');
  const aerowayIdx = styleLayers.indexOf('aeroway_fill');
  const roadIdx = styleLayers.indexOf('tunnel_motorway_link_casing');
  const buildingIdx = styleLayers.indexOf('building-3d');
  const boundaryIdx = styleLayers.indexOf('boundary_2');
  const labelIdx = styleLayers.indexOf('label_country_1');

  expect(hitIdx).toBeGreaterThan(sandIdx);
  expect(fillIdx).toBeGreaterThan(hitIdx);
  expect(outlineIdx).toBeGreaterThan(fillIdx);
  expect(selectedFillIdx).toBeGreaterThan(outlineIdx);
  expect(selectedOutlineIdx).toBeGreaterThan(selectedFillIdx);
  expect(aerowayIdx).toBeGreaterThan(selectedOutlineIdx);
  expect(roadIdx).toBeGreaterThan(selectedOutlineIdx);
  expect(buildingIdx).toBeGreaterThan(selectedOutlineIdx);
  expect(boundaryIdx).toBeGreaterThan(selectedOutlineIdx);
  expect(labelIdx).toBeGreaterThan(selectedOutlineIdx);

  // Verify Russian label expressions on geographic layers and preservation of technical layers
  for (const item of inspection.russianLayers) {
    expect(item.textField).toEqual(['coalesce', ['get', 'name:ru'], ['get', 'name']]);
  }
  expect(inspection.technicalLayers.shield).toBe('{ref}');
  expect(inspection.technicalLayers.housenumber).toBe('{housenumber}');

  // Verify attribution is visible in viewport
  const attrib = page.locator('.maplibregl-ctrl-attrib');
  await expect(attrib).toBeVisible();
  await expect(attrib).toContainText('OpenFreeMap');
  await expect(attrib).toContainText('OpenMapTiles');
  await expect(attrib).toContainText('OpenStreetMap');
  const attribBox = await attrib.boundingBox();
  const viewport = page.viewportSize()!;
  expect(attribBox).not.toBeNull();
  expect(attribBox!.x).toBeGreaterThanOrEqual(0);
  expect(attribBox!.y).toBeGreaterThanOrEqual(0);
  expect(attribBox!.x + attribBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(attribBox!.y + attribBox!.height).toBeLessThanOrEqual(viewport.height);
});

test('shows Russian error UI and recovers on retry when style fails', async ({ page }) => {
  let shouldFailStyle = true;
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/styles/liberty')) {
      if (shouldFailStyle) {
        await route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'Service Unavailable',
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LIBERTY_STYLE_FIXTURE),
      });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  });

  await page.goto('/');
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'error');
  await expect(page.getByRole('heading', { name: 'Не удалось отобразить карту' })).toBeVisible();

  shouldFailStyle = false;
  await page.getByTestId('map-retry-button').click();
  await waitForMapReady(page);
});

test('renders Russian error state when WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) {
      if (contextId === 'webgl2') {
        return null;
      }
      return origGetContext.call(this, contextId as '2d', options as CanvasRenderingContext2DSettings);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await stubExternalServices(page);
  await page.goto('/');
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'error');
  await expect(
    page.getByText('Не удалось инициализировать WebGL2 для отображения 3D-карты.').first(),
  ).toBeVisible();
});
