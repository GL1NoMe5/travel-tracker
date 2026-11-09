import { readFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';

type MapRoot = HTMLElement & { __travelMap: MapLibreMap };
type Point = { x: number; y: number };
type CountryCamera = { code: string; center: [number, number]; zoom: number };

const geography = JSON.parse(readFileSync(
  new URL('../../src/data/country-geography.json', import.meta.url), 'utf8',
)) as CountryCamera[];

async function prepareMap(page: Page) {
  const reverseRequests: URL[] = [];
  await page.route('https://tiles.openfreemap.org/**', async route => {
    if (route.request().url().includes('/styles/liberty')) {
      await route.fulfill({ json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eaf2ef' } }],
      } });
    } else await route.abort();
  });
  await page.route('https://nominatim.openstreetmap.org/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/reverse') reverseRequests.push(url);
    await route.fulfill({ json: {
      osm_type: 'relation', osm_id: 987654,
      lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon'),
      name: 'Точка проверки', display_name: 'Точка проверки, Чад',
      addresstype: 'city', type: 'administrative',
      address: { city: 'Точка проверки', country_code: 'td' },
      namedetails: { 'name:ru': 'Точка проверки' },
    } });
  });
  // The application's actual /data/countries.geojson is deliberately not intercepted.
  await page.goto('/');
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 20000 });
  await page.waitForFunction(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    return map.isSourceLoaded('travel-countries') && map.areTilesLoaded();
  });
  return reverseRequests;
}

async function positionMap(page: Page, center: [number, number], zoom: number) {
  await page.evaluate(async ({ center, zoom }) => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    map.stop();
    await new Promise<void>(resolve => {
      map.once('idle', () => resolve());
      map.jumpTo({ center, zoom, bearing: 0, pitch: 0 });
      map.triggerRepaint();
    });
  }, { center, zoom });
  return page.evaluate(center => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const point = map.project(center);
    const rect = map.getCanvas().getBoundingClientRect();
    const x = point.x + rect.left;
    const y = point.y + rect.top;
    return { x, y, unobstructed: document.elementFromPoint(x, y) === map.getCanvas() };
  }, center);
}

async function activatePoint(page: Page, point: Point, mobile: boolean) {
  if (mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function touchGesture(session: CDPSession, start: Point[], finish: Point[]) {
  const points = (values: Point[]) => values.map((point, index) => ({
    ...point, id: index + 1, radiusX: 2, radiusY: 2, force: 1,
  }));
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
  for (let step = 1; step <= 10; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: points(start.map((point, index) => ({
        x: point.x + (finish[index].x - point.x) * step / 10,
        y: point.y + (finish[index].y - point.y) * step / 10,
      }))),
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('actual country geometry selects microstates and multipart countries at catalog centers', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await prepareMap(page);
  const mobile = testInfo.project.name === 'mobile';
  const evidence: { code: string; center: number[]; zoom: number; hits: string[] }[] = [];
  for (const code of ['VA', 'MC', 'TV', 'PS', 'FR', 'NO', 'RU', 'FJ']) {
    await test.step(`Rendered hit and ${mobile ? 'tap' : 'click'}: ${code}`, async () => {
      const camera = geography.find(country => country.code === code)!;
      const point = await positionMap(page, camera.center, camera.zoom);
      expect(point.unobstructed, `${code}: interaction must reach the map canvas`).toBe(true);
      const hits = await page.evaluate(center => {
        const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
        return map.queryRenderedFeatures(map.project(center), { layers: ['travel-countries-hit'] })
          .map(feature => String(feature.properties?.iso2));
      }, camera.center);
      expect(hits, `${code}: center must hit actual rendered GeoJSON`).toContain(code);
      evidence.push({ ...camera, hits });
      await activatePoint(page, point, mobile);
      await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', code);
      await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
      await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', '');
    });
  }
  await testInfo.attach('rendered-country-hits', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});

test('flag mode ignores empty globe space and gestures but accepts a single ordinary tap', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const reverseRequests = await prepareMap(page);
  const mobile = testInfo.project.name === 'mobile';
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await page.getByRole('button', { name: /^Выбрать на карте/ }).click();

  await positionMap(page, [20, 20], -0.5);
  const outside = await page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const center = map.project([20, 20]);
    const rect = map.getCanvas().getBoundingClientRect();
    for (const dx of [-130, 130]) {
      const point = { x: center.x + dx, y: center.y };
      const roundTrip = map.project(map.unproject([point.x, point.y]));
      const screen = { x: point.x + rect.left, y: point.y + rect.top };
      if (Math.hypot(roundTrip.x - point.x, roundTrip.y - point.y) > 20 &&
          document.elementFromPoint(screen.x, screen.y) === map.getCanvas()) return screen;
    }
    return null;
  });
  expect(outside, 'An unobstructed point demonstrably outside the globe must exist').not.toBeNull();
  await activatePoint(page, outside!, mobile);

  async function expectNoPoint() {
    // Include the browser's delayed synthetic click after touchend, if any.
    await page.waitForTimeout(400);
    await expect(page.getByTestId('draft-city-marker')).toHaveCount(0);
    await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
    expect(reverseRequests).toHaveLength(0);
  }
  await expectNoPoint();

  const center = await positionMap(page, [20, 20], 2.5);
  expect(center.unobstructed).toBe(true);
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    try {
      await touchGesture(session, [{ x: center.x - 25, y: center.y }], [{ x: center.x + 35, y: center.y + 20 }]);
      await expect.poll(() => page.evaluate(() => {
        const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
        const current = map.getCenter();
        return Math.hypot(current.lng - 20, current.lat - 20);
      })).toBeGreaterThan(0.1);
      await expectNoPoint();

      const pinchCenter = await positionMap(page, [20, 20], 2.5);
      await touchGesture(session,
        [{ x: pinchCenter.x - 20, y: pinchCenter.y }, { x: pinchCenter.x + 20, y: pinchCenter.y }],
        [{ x: pinchCenter.x - 55, y: pinchCenter.y }, { x: pinchCenter.x + 55, y: pinchCenter.y }],
      );
      await expect.poll(() => page.evaluate(() =>
        (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getZoom(),
      )).toBeGreaterThan(2.7);
      await expectNoPoint();
    } finally { await session.detach(); }
  } else {
    await page.mouse.move(center.x - 25, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 35, center.y + 20, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => {
      const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
      const current = map.getCenter();
      return Math.hypot(current.lng - 20, current.lat - 20);
    })).toBeGreaterThan(0.1);
    await expectNoPoint();
  }

  const tapPoint = await positionMap(page, [20, 20], 2.5);
  expect(tapPoint.unobstructed).toBe(true);
  await activatePoint(page, tapPoint, mobile);
  await expect(page.getByTestId('draft-city-marker')).toHaveCount(1);
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Точка проверки');
  expect(reverseRequests).toHaveLength(1);
  expect(Number(reverseRequests[0].searchParams.get('lon'))).toBeCloseTo(20, 2);
  expect(Number(reverseRequests[0].searchParams.get('lat'))).toBeCloseTo(20, 2);
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', '');
  expect(await page.evaluate(() => localStorage.getItem('travel-tracker:data:v1'))).toBeNull();
});
