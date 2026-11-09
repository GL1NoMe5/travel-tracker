import { expect, test } from '@playwright/test';
import { boot, city, openCities, openSearch, seed, selectCountry, type MapRoot } from './helpers';

test('phone, intermediate and desktop widths keep active controls reachable without overflow', async ({ page }) => {
  await boot(page);
  for (const width of [390, 761, 820, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await selectCountry(page);
    await expect(page.getByRole('button', { name: 'Я здесь был', exact: true })).toBeVisible();
    const measurements = await page.evaluate(() => {
      const panel = document.querySelector('#travel-panel')!.getBoundingClientRect();
      const canvas = document.querySelector('canvas.maplibregl-canvas')!;
      const controls = [...document.querySelectorAll('.travel-map__control-btn')].map(element => {
        const r = element.getBoundingClientRect();
        const points = [[r.x + r.width / 2, r.y + r.height / 2],
          [r.left + 4, r.y + r.height / 2], [r.right - 4, r.y + r.height / 2],
          [r.x + r.width / 2, r.top + 4], [r.x + r.width / 2, r.bottom - 4]];
        const reachable = points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit === element || element.contains(hit);
        });
        return { width: r.width, height: r.height, reachable };
      });
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        panel: { x: panel.x, right: panel.right, bottom: panel.bottom, height: panel.height },
        controls, canvasVisible: canvas.getBoundingClientRect().width > 0,
      };
    });
    expect(measurements.overflow).toBe(false);
    expect(measurements.panel.x).toBeGreaterThanOrEqual(0);
    expect(measurements.panel.right).toBeLessThanOrEqual(width);
    expect(measurements.panel.bottom).toBeLessThanOrEqual(width === 390 ? 844 : 900);
    expect(measurements.controls).toHaveLength(3);
    for (const control of measurements.controls) {
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.reachable).toBe(true);
    }
    if (width === 390) expect(measurements.panel.height).toBeLessThan(844 * 0.6);
    await page.getByRole('button', { name: 'Закрыть страну', exact: true }).click();
  }
  await openSearch(page);
  await expect(page.getByLabel('Страна или город', { exact: true })).toBeVisible();
});

test('a long place editor at 761 by 600 leaves the entire map control targets uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 761, height: 600 });
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [city({
    name: 'Париж — место, куда хочется вернуться всей семьёй',
    visits: [{ id: 'long-visit', date: '2025-08-15', note: 'Долгая прогулка по городу. '.repeat(24) }],
  })] });
  await boot(page);
  await openCities(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  await expect(page.getByLabel('Название места', { exact: true })).toBeVisible();
  await expect(page.locator('.travel-map__control-btn')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => {
    const panel = document.querySelector('#travel-panel')!.getBoundingClientRect();
    return [...document.querySelectorAll('.travel-map__control-btn')].every(element => {
      const r = element.getBoundingClientRect();
      // Test the whole hit target, not only a center that can remain barely exposed.
      const points = [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8],
        [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8],
        [r.left + 4, r.y + r.height / 2], [r.right - 4, r.y + r.height / 2],
        [r.x + r.width / 2, r.y + r.height / 2]];
      return r.right <= panel.left && points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      });
    });
  })).toBe(true);
  const before = await page.evaluate(() =>
    (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getZoom());
  await page.getByRole('button', { name: 'Увеличить масштаб карты', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getZoom())).toBeGreaterThan(before);
  await expect(page.getByLabel('Название места', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
