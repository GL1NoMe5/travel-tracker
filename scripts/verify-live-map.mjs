// Opt-in visual QA against real OpenFreeMap, never part of the offline fixture suite.
// Start production preview, then run: node scripts/verify-live-map.mjs
// Only geocoding is intercepted. All saved places are created through the UI.
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = process.env.TRAVEL_QA_OUTPUT ?? 'artifacts/ui-redesign';
const baseURL = process.env.TRAVEL_E2E_BASE_URL ?? 'http://127.0.0.1:4173';
const storageKey = 'travel-tracker:data:v1';
const france = JSON.parse(await readFile(new URL('../src/data/country-geography.json', import.meta.url), 'utf8')).find(country => country.code === 'FR');
const paris = {
  osm_type: 'relation', osm_id: 7444, lon: '2.3522', lat: '48.8566',
  name: 'Париж', display_name: 'Париж, Иль-де-Франс, Франция',
  addresstype: 'city', type: 'administrative',
  address: { city: 'Париж', country_code: 'fr', state: 'Иль-де-Франс' },
  namedetails: { 'name:ru': 'Париж' },
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const findings = [];

async function assertSimpleUI(page) {
  await expect(page.getByRole('button', { name: /экспорт|импорт|json/i })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByLabel(/Долгота|Широта/)).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toMatch(/экспорт|импорт|JSON/i);
}

async function settleMap(page) {
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const map = document.querySelector('[data-testid="travel-map"]')?.__travelMap;
    return map && !map.isMoving() && map.loaded() && map.areTilesLoaded();
  }, null, { timeout: 45_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(page, name, state) {
  await settleMap(page);
  await assertSimpleUI(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}-${state}.png`, animations: 'disabled' });
}

async function openSearch(page) {
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await expect(page.getByLabel('Страна или город', { exact: true })).toBeVisible();
}

try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: name === 'mobile', hasTouch: name === 'mobile',
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      const geocodingRequests = [];
      const basemapResponses = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (response.url().startsWith('https://tiles.openfreemap.org/') && response.ok()) {
          basemapResponses.push(response.url());
        }
      });
      // Pin the provider in this isolated QA context, then fulfill every request locally.
      await page.route('**/config.json', route => route.fulfill({
        json: { geocoding: { baseUrl: 'https://nominatim.openstreetmap.org/' } },
      }));
      await page.route('https://nominatim.openstreetmap.org/**', route => {
        const url = new URL(route.request().url());
        geocodingRequests.push({ path: url.pathname, query: url.searchParams.get('q') });
        return route.fulfill({ json: url.pathname.endsWith('/search') ? [paris] : paris });
      });
      await page.goto(baseURL);
      expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
      await capture(page, name, 'globe-empty');
      expect(geocodingRequests).toEqual([]);
      expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();

      await openSearch(page);
      await page.getByLabel('Страна или город', { exact: true }).fill('Франция');
      await expect(page.getByRole('button', { name: 'Франция', exact: true })).toBeVisible();
      await capture(page, name, 'search');
      expect(geocodingRequests).toEqual([]);
      await page.getByRole('button', { name: 'Франция', exact: true }).click();
      await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Отмечено', exact: true })).toBeDisabled();
      await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').countryColors?.FR, storageKey)).toBe('#C45B3D');
      await expect.poll(() => page.evaluate(country => {
        const map = document.querySelector('[data-testid="travel-map"]').__travelMap;
        const center = map.getCenter();
        return !map.isMoving() && Math.hypot(center.lng - country.center[0], center.lat - country.center[1]) < 0.0001 && Math.abs(map.getZoom() - country.zoom) < 0.001;
      }, france), { timeout: 10_000 }).toBe(true);
      await capture(page, name, 'france');

      const transition = await page.evaluate(async () => {
        const map = document.querySelector('[data-testid="travel-map"]').__travelMap;
        const canvas = map.getCanvas();
        const projection = map.getProjection();
        map.jumpTo({ zoom: 4.8 });
        const frames = [];
        const sample = () => frames.push(map.getZoom());
        map.on('render', sample);
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Projection animation did not finish')), 10_000);
            map.once('moveend', () => { clearTimeout(timeout); resolve(); });
            map.easeTo({ zoom: 6.2, duration: 1500, essential: true });
          });
        } finally { map.off('render', sample); }
        return {
          projection, intermediateFrames: frames.filter(zoom => zoom > 5 && zoom < 6).length,
          sameCanvas: canvas === map.getCanvas(), zoom: map.getZoom(),
        };
      });
      expect(transition.projection).toEqual({
        type: ['interpolate', ['linear'], ['zoom'], 5, 'vertical-perspective', 6, 'mercator'],
      });
      expect(transition.sameCanvas).toBe(true);
      expect(transition.intermediateFrames).toBeGreaterThan(1);
      expect(transition.zoom).toBeCloseTo(6.2);
      await capture(page, name, 'mercator');
      await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();

      await openSearch(page);
      await page.getByLabel('Страна или город', { exact: true }).fill('Париж');
      expect(geocodingRequests).toEqual([]);
      await page.getByRole('button', { name: 'Найти город', exact: true }).click();
      await page.getByRole('list', { name: 'Результаты поиска города' }).getByRole('button').first().click();
      await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Париж');
      await page.getByLabel('Дата посещения', { exact: true }).fill('2025-09-21');
      await page.getByLabel('Заметка', { exact: true }).fill('Утренний кофе и прогулка вдоль Сены');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'Мои места', exact: true }).click();
      await page.getByRole('tab', { name: /^Места/ }).click();
      await expect(page.locator('[data-city-list-id]')).toHaveCount(1);
      await page.locator('[data-city-list-id]').click();
      await expect(page.getByLabel('Дата посещения', { exact: true })).toHaveValue('2025-09-21');
      await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('Утренний кофе и прогулка вдоль Сены');
      await capture(page, name, 'place-editor');
      await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
      await page.getByRole('button', { name: 'Сбросить вид карты к глобусу', exact: true }).click();
      await settleMap(page);
      await page.getByRole('button', { name: 'Мои места', exact: true }).click();
      await page.getByRole('tab', { name: /^Места/ }).click();
      await capture(page, name, 'collection');
      await page.getByRole('button', { name: 'Закрыть панель', exact: true }).click();

      const beforeReload = await page.evaluate(key => localStorage.getItem(key), storageKey);
      await page.reload();
      await capture(page, name, 'globe-returning');
      const afterReload = await page.evaluate(key => localStorage.getItem(key), storageKey);
      expect(afterReload).toBe(beforeReload);
      const saved = JSON.parse(afterReload);
      expect(saved.countryColors).toEqual({ FR: '#C45B3D' });
      expect(saved.cities).toHaveLength(1);
      expect(saved.cities[0]).toMatchObject({ name: 'Париж', coordinates: [2.3522, 48.8566] });
      expect(saved.cities[0].visits).toHaveLength(1);
      expect(saved.cities[0].visits[0]).toMatchObject({ date: '2025-09-21', note: 'Утренний кофе и прогулка вдоль Сены' });
      expect(geocodingRequests).toEqual([{ path: '/search', query: 'Париж' }]);
      expect(basemapResponses.some(url => url.includes('/styles/liberty'))).toBe(true);
      expect(basemapResponses.some(url => !url.includes('/styles/liberty'))).toBe(true);
      expect(errors).toEqual([]);
      findings.push({
        name, viewport: { width, height }, transition, pageErrors: errors,
        realBasemapResponses: basemapResponses.length,
        fixtureGeocodingRequests: geocodingRequests,
        persistedAfterReload: { countries: Object.keys(saved.countryColors).length, places: saved.cities.length },
      });
      console.log(`${name}: 7 captures, real basemap, fixture search, persistence and projection passed`);
    } finally { await context.close(); }
  }
  await writeFile(`${output}/live-result.json`, JSON.stringify(findings, null, 2));
  console.log(JSON.stringify(findings, null, 2));
} finally { await browser.close(); }
