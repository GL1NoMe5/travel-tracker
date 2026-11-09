import { expect, test, type Page } from '@playwright/test';
import { selectCountry, type MapRoot } from './helpers';

const style = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#dbece5' } }] };

async function localStyle(page: Page) {
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({ json: style }));
}
async function ready(page: Page) {
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready');
}

test('resizing an existing globe updates layout without recreating the canvas', async ({ page }) => {
  await localStyle(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await ready(page);
  const canvas = await page.locator('canvas.maplibregl-canvas').elementHandle();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid="travel-map"]') as any).__travelMap.getPadding().left)).toBe(16);
  expect(await canvas!.evaluate(el => el === document.querySelector('canvas.maplibregl-canvas'))).toBe(true);
  const layout = await page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as any).__travelMap;
    return { padding: map.getPadding(), center: map.project(map.getCenter()), zoom: map.getZoom() };
  });
  expect(layout.center.x).toBeCloseTo(195, 0);
  expect(layout.center.y).toBeGreaterThan(156);
  expect(layout.center.y).toBeLessThan(844 - layout.padding.bottom);
  expect(layout.zoom).toBeLessThan(1.5);
});

test('country editor reserves right-hand space and releases it on close', async ({ page }) => {
  await localStyle(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await page.getByLabel('Страна или город', { exact: true }).fill('Франция');
  await page.getByRole('button', { name: 'Франция', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid="travel-map"]') as any).__travelMap.getPadding().right)).toBeGreaterThan(300);
  await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (document.querySelector('[data-testid="travel-map"]') as any).__travelMap.getPadding().right)).toBe(20);
});

test('closing the editor during a flight cannot restore stale panel padding', async ({ page }) => {
  await localStyle(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await page.getByLabel('Страна или город', { exact: true }).fill('Франция');
  await page.getByRole('button', { name: 'Франция', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as any).__travelMap;
    return !map.isMoving() && map.getPadding().right === 20;
  })).toBe(true);
});

test('closing a country while style loading cancels its deferred flight', async ({ page }) => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('https://tiles.openfreemap.org/styles/liberty', async route => {
    requested = true;
    await barrier;
    await route.fulfill({ json: style });
  });
  try {
    await page.goto('/');
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'loading');
    await selectCountry(page);
    await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', 'FR');
    // Let the camera request queue while its style remains deliberately unavailable.
    await page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
    await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', '');
  } finally { release(); }
  await ready(page);
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const center = map.getCenter();
    return {
      initialCenter: Math.hypot(center.lng - 20, center.lat - 20) < 0.0001,
      globeZoom: map.getZoom() < 3,
      moving: map.isMoving(),
    };
  })).toEqual({ initialCenter: true, globeZoom: true, moving: false });
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', '');
  await expect(page.locator('#travel-panel')).toHaveCount(0);
});

test('loading status remains until country geometry arrives', async ({ page }) => {
  await localStyle(page);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/data/countries.geojson', async route => { requested = true; await barrier; await route.continue(); });
  try {
    await page.goto('/');
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'loading');
  } finally {
    release();
  }
  await ready(page);
});

test('missing basemap TileJSON produces a recoverable error', async ({ page }) => {
  const remoteStyle = { ...style, sources: { basemap: { type: 'vector', url: 'https://tiles.openfreemap.org/test-tilejson' } }, layers: [...style.layers, { id: 'land', type: 'fill', source: 'basemap', 'source-layer': 'land' }] };
  await page.route('https://tiles.openfreemap.org/styles/liberty', route => route.fulfill({ json: remoteStyle }));
  await page.route('https://tiles.openfreemap.org/test-tilejson', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'error');
  await expect(page.getByTestId('map-retry-button')).toBeVisible();
});

test('losing WebGL context reports an error instead of a ready blank map', async ({ page }) => {
  await localStyle(page);
  await page.goto('/');
  await ready(page);
  await page.locator('canvas.maplibregl-canvas').evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('webgl2');
    const extension = context?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Test requires WEBGL_lose_context');
    extension.loseContext();
  });
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'error');
  await expect(page.getByTestId('map-retry-button')).toBeVisible();
});

test('a GeoJSON failure is recoverable without leaving a stale application alert', async ({ page }) => {
  await localStyle(page);
  let fail = true;
  await page.route('**/data/countries.geojson', route => fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  await page.goto('/');
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'error');
  fail = false;
  await page.getByTestId('map-retry-button').click();
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
