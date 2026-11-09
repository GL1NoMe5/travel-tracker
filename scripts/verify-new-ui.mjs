// Real OpenFreeMap visual QA. Start dev/preview, then run this script.
// All user data belongs to fresh, isolated Playwright browser contexts.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const baseURL = process.env.TRAVEL_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const output = process.env.TRAVEL_QA_OUTPUT ?? 'artifacts/country-themes';
const data = {
  schemaVersion: 1, countryColors: { KG: '#46A88C', FR: '#68A8D5', KZ: '#C45B3D' },
  countryVisits: { KG: 3, FR: 2, KZ: 1 },
  cities: [{ id: 'qa-paris', name: 'Париж', coordinates: [2.35, 48.85], countryCode: 'FR', osmRefs: [],
    visits: [{ id: 'qa-paris-visit', date: '2025-05-17', note: 'Прогулка по набережной' }] }],
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];

async function settle(page) {
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 60_000 });
  await page.waitForFunction(() => {
    const map = document.querySelector('[data-testid="travel-map"]')?.__travelMap;
    return map && !map.isMoving() && map.loaded() && map.areTilesLoaded();
  }, null, { timeout: 45_000 });
  // Tile readiness precedes MapLibre's symbol fade and paint transitions.
  // Wait past their default durations so screenshots capture stable labels.
  await page.waitForTimeout(750);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function capture(page, profile, state) {
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${profile}-${state}.png`, animations: 'disabled' });
}

try {
  for (const [profile, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: profile === 'mobile', hasTouch: profile === 'mobile', colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // This script never needs live geocoding; all selections are local countries.
      await page.route('https://nominatim.openstreetmap.org/**', route => route.abort());
      await page.addInitScript(data => {
        if (!localStorage.getItem('travel-tracker:data:v1')) localStorage.setItem('travel-tracker:data:v1', JSON.stringify(data));
      }, data);
      await page.goto(baseURL);
      await capture(page, profile, 'home-light');
      await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await capture(page, profile, 'home-dark');
      await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
      await page.getByLabel('Страна или город', { exact: true }).fill('Киргизия');
      await page.getByRole('button', { name: 'Киргизия', exact: true }).click();
      await expect(page.getByLabel('Количество посещений', { exact: true })).toHaveValue('3');
      await capture(page, profile, 'country-dark');
      await page.getByRole('button', { name: 'Включить светлую тему', exact: true }).click();
      await capture(page, profile, 'country-light');
      await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
      await page.getByRole('button', { name: 'Мои места', exact: true }).click();
      await capture(page, profile, 'collection-light');
      expect(errors).toEqual([]);
      results.push({ profile, width, height, errors, screenshotStates: ['home-light', 'home-dark', 'country-dark', 'country-light', 'collection-light'] });
    } finally { await context.close(); }
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
