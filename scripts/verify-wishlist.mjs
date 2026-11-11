// Real OpenFreeMap visual QA, with isolated data and no live Nominatim calls.
// Start the packaged app or preview and set TRAVEL_E2E_BASE_URL if needed.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const baseURL = process.env.TRAVEL_E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const output = process.env.TRAVEL_QA_OUTPUT ?? 'artifacts/wishlist';
const data = {
  schemaVersion: 1, countryColors: { FR: '#68A8D5', KG: '#46A88C' }, countryVisits: { FR: 2, KG: 3 },
  cities: [
    { id: 'qa-paris', name: 'Париж', coordinates: [2.35, 48.85], countryCode: 'FR', osmRefs: [],
      visits: [{ id: 'qa-paris-visit', date: '2025-05-17', note: 'Прогулка по набережной' }] },
    { id: 'qa-istanbul', name: 'Стамбул', coordinates: [28.97, 41.01], countryCode: 'TR', osmRefs: [], status: 'wishlist', visits: [],
      wishNote: 'Прокатиться на пароме по Босфору и встретить закат у Галатской башни.' },
    { id: 'qa-lisbon', name: 'Лиссабон', coordinates: [-9.14, 38.72], countryCode: 'PT', osmRefs: [], status: 'wishlist', visits: [],
      wishNote: 'Трамвай № 28 и прогулка по старым улицам.' },
  ],
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
  await page.waitForTimeout(750); // Symbols fade after tile readiness, independently of reduced motion.
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
      await page.route('https://nominatim.openstreetmap.org/**', route => route.abort());
      await page.addInitScript(data => {
        if (!localStorage.getItem('travel-tracker:data:v1')) localStorage.setItem('travel-tracker:data:v1', JSON.stringify(data));
      }, data);
      await page.goto(baseURL);
      await expect(page.locator('[data-place-status="wishlist"][data-city-id]')).toHaveCount(2);
      await capture(page, profile, 'home-light');
      await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
      await capture(page, profile, 'home-dark');
      await page.getByRole('button', { name: 'Хочу посетить', exact: true }).click();
      await expect(page.getByRole('tab', { name: /^Хочу посетить/ })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-city-list-id]')).toHaveCount(2);
      await capture(page, profile, 'list-dark');
      await page.getByText('Цвет отметок', { exact: true }).click();
      await expect(page.getByLabel('Цвет посещённых мест', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Цвет желаний', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Вернуть цвета', exact: true }).scrollIntoViewIfNeeded();
      await capture(page, profile, 'colors-dark');
      await page.getByText('Цвет отметок', { exact: true }).click();
      await page.locator('[data-city-list-id="qa-istanbul"]').click();
      await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue(data.cities[1].wishNote);
      await expect(page.getByLabel('Дата посещения', { exact: true })).toHaveCount(0);
      await capture(page, profile, 'editor-dark');
      await page.getByRole('button', { name: 'Включить светлую тему', exact: true }).click();
      await capture(page, profile, 'editor-light');
      expect(errors).toEqual([]);
      results.push({ profile, width, height, errors, screenshotStates: ['home-light', 'home-dark', 'list-dark', 'colors-dark', 'editor-dark', 'editor-light'] });
    } finally { await context.close(); }
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
