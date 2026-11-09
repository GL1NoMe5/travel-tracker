import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, nominatimPlace, openSearch, searchResult, selectCountry, type MapRoot } from './helpers';

test('panel changes and breakpoint resize keep one canvas without observer errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  const canvas = await page.locator('canvas.maplibregl-canvas').elementHandle();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await openSearch(page);
    await expect(page.locator('#travel-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    await page.getByRole('button', { name: 'Мои места', exact: true }).click();
    await page.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
  }
  await page.waitForTimeout(350);
  await expect(page.locator('canvas.maplibregl-canvas')).toHaveCount(1);
  expect(await canvas!.evaluate(el => el === document.querySelector('canvas.maplibregl-canvas'))).toBe(true);
  expect(errors).toEqual([]);
});

test('searching Paris reaches its actual center and zoom after the editor opens', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [nominatimPlace(7444, 'Париж', 2.3522, 48.8566)] }));
  await boot(page);
  await searchResult(page);
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Париж');
  await expect.poll(() => page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const center = map.getCenter();
    return {
      atParis: Math.hypot(center.lng - 2.3522, center.lat - 48.8566) < 0.0001,
      cityZoom: Math.abs(map.getZoom() - 10.5) < 0.001,
      moving: map.isMoving(),
    };
  }), { timeout: 10000 }).toEqual({ atParis: true, cityZoom: true, moving: false });
  expect(errors).toEqual([]);
});

test('marking a country during its flight still reaches the country center and zoom after the sheet grows', async ({ page }) => {
  await boot(page);
  const france = (JSON.parse(readFileSync(new URL('../../src/data/country-geography.json', import.meta.url), 'utf8')) as
    { code: string; center: [number, number]; zoom: number }[]).find(country => country.code === 'FR')!;
  await selectCountry(page);
  // Do not wait for flyTo: adding the removal action changes the mobile sheet's height.
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Убрать отметку', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(({ center, zoom }) => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const actual = map.getCenter();
    return {
      reachedCountry: Math.hypot(actual.lng - center[0], actual.lat - center[1]) < 0.0001,
      reachedZoom: Math.abs(map.getZoom() - zoom) < 0.001,
      moving: map.isMoving(),
    };
  }, { center: france.center, zoom: france.zoom }), { timeout: 10000 })
    .toEqual({ reachedCountry: true, reachedZoom: true, moving: false });
});
