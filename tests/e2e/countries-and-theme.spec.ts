import { expect, test, type Page } from '@playwright/test';
import { boot, city, persisted, ready, seed, selectCountry, STORAGE_KEY, type MapRoot } from './helpers';

const THEME_KEY = 'travel-tracker:theme:v1';

async function forceLight(page: Page) {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function setCustomColor(page: Page, color: string) {
  const picker = page.getByLabel('Свой цвет страны', { exact: true });
  await picker.fill(color);
}

test('country palette and custom color preserve the independently editable visit count after reload', async ({ page }) => {
  await forceLight(page);
  await boot(page);
  await selectCountry(page, 'Киргизия');
  const palette = page.locator('.country-palette');
  await expect(palette).toBeVisible();
  const firstColor = palette.getByRole('button').first();
  await firstColor.click();
  await expect(firstColor).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await persisted(page)).countryVisits?.KG).toBe(1);
  await setCustomColor(page, '#1967d2');
  await expect.poll(async () => (await persisted(page)).countryColors.KG).toBe('#1967D2');

  const count = page.getByLabel('Количество посещений', { exact: true });
  await expect(count).toHaveValue('1');
  await count.fill('3');
  await count.press('Tab');
  await expect.poll(async () => (await persisted(page)).countryVisits?.KG).toBe(3);
  await page.getByRole('button', { name: 'Добавить посещение', exact: true }).click();
  await expect(count).toHaveValue('4');
  await page.getByRole('button', { name: 'Уменьшить количество посещений', exact: true }).click();
  await expect(count).toHaveValue('3');
  expect((await persisted(page)).cities).toEqual([]);

  await page.reload();
  await ready(page);
  await selectCountry(page, 'Киргизия');
  await expect(count).toHaveValue('3');
  await expect(page.getByLabel('Свой цвет страны', { exact: true })).toHaveValue('#1967d2');
  await expect.poll(() => page.evaluate(() => JSON.stringify(
    (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getPaintProperty('travel-countries-fill', 'fill-color'),
  ))).toContain('#1967D2');
  await page.getByRole('button', { name: 'Убрать отметку', exact: true }).click();
  await expect.poll(async () => (await persisted(page)).countryColors).toEqual({});
  expect((await persisted(page)).countryVisits).toEqual({});
});

test('legacy countries receive one visit while city history and other country colors remain intact', async ({ page }) => {
  const legacyCity = city({ visits: [
    { id: 'first-legacy-visit', date: '2020-01-03', note: 'Первая поездка' },
    { id: 'second-legacy-visit', date: '2025-08-09', note: 'Возвращение' },
  ] });
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#9B6EF3', KG: '#48A9A6' }, cities: [legacyCity] });
  await boot(page);
  await selectCountry(page, 'Франция');
  await expect(page.getByLabel('Количество посещений', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Добавить посещение', exact: true }).click();
  await expect.poll(async () => (await persisted(page)).countryVisits).toEqual({ FR: 2, KG: 1 });
  const after = await persisted(page);
  expect(after.countryColors).toEqual({ FR: '#9B6EF3', KG: '#48A9A6' });
  expect(after.cities).toEqual([legacyCity]);
  await setCustomColor(page, '#a05330');
  await expect.poll(async () => (await persisted(page)).countryColors.FR).toBe('#A05330');
  expect((await persisted(page)).countryVisits?.FR).toBe(2);
});

test('a queued country edit freezes its controls and applies one increment after the write lock is released', async ({ page }) => {
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#C45B3D' }, cities: [] });
  await boot(page);
  await selectCountry(page);
  await page.evaluate(() => new Promise<void>(acquired => {
    void navigator.locks.request('travel-tracker:write:v1', () => new Promise<void>(release => {
      (window as Window & { releaseCountryWrite?: () => void }).releaseCountryWrite = release;
      acquired();
    }));
  }));
  try {
    await page.getByRole('button', { name: 'Добавить посещение', exact: true }).click();
    await expect(page.getByLabel('Количество посещений', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Добавить посещение', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Свой цвет страны', { exact: true })).toBeDisabled();
    expect((await persisted(page)).countryVisits).toBeUndefined();
  } finally {
    await page.evaluate(() => (window as Window & { releaseCountryWrite?: () => void }).releaseCountryWrite?.());
  }
  await expect.poll(async () => (await persisted(page)).countryVisits?.FR).toBe(2);
  await expect(page.getByLabel('Количество посещений', { exact: true })).toBeEnabled();
});

test('typed visit counts drive the stepper, reject invalid values and protect unsaved changes', async ({ page }) => {
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#C45B3D' }, countryVisits: { FR: 1 }, cities: [] });
  await boot(page);
  await selectCountry(page);
  const count = page.getByLabel('Количество посещений', { exact: true });
  await count.fill('5');
  await page.getByRole('button', { name: 'Добавить посещение', exact: true }).click();
  await expect(count).toHaveValue('6');
  await count.fill('5');
  await page.getByRole('button', { name: 'Уменьшить количество посещений', exact: true }).click();
  await expect(count).toHaveValue('4');
  for (const value of ['0', '1000']) {
    await count.fill(value);
    await count.press('Enter');
    await expect(count).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toContainText('от 1 до 999');
    expect((await persisted(page)).countryVisits?.FR).toBe(4);
  }
  await count.fill('999');
  await count.press('Enter');
  await expect.poll(async () => (await persisted(page)).countryVisits?.FR).toBe(999);
  await expect(page.getByRole('button', { name: 'Добавить посещение', exact: true })).toBeDisabled();
  await count.fill('10');
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(count).toHaveValue('10');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(count).toHaveCount(0);
  expect((await persisted(page)).countryVisits?.FR).toBe(999);
});

test('dark theme persists and recolors the basemap without replacing the globe or changing travel data', async ({ page }) => {
  await forceLight(page);
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#F4A259' }, countryVisits: { FR: 3 }, cities: [city()] });
  await boot(page);
  await selectCountry(page);
  await expect.poll(() => page.evaluate(() => !(document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.isMoving())).toBe(true);
  const canvas = await page.locator('canvas.maplibregl-canvas').elementHandle();
  const before = await page.evaluate(key => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    return { data: localStorage.getItem(key), background: map.getPaintProperty('background', 'background-color'),
      fill: map.getPaintProperty('travel-countries-fill', 'fill-color'), zoom: map.getZoom(), center: map.getCenter().toArray() };
  }, STORAGE_KEY);
  await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(() =>
    (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getPaintProperty('background', 'background-color'),
  )).not.toEqual(before.background);
  expect(await canvas!.evaluate(element => element === document.querySelector('canvas.maplibregl-canvas'))).toBe(true);
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-selected-country', 'FR');
  const after = await page.evaluate(key => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    return { data: localStorage.getItem(key), fill: map.getPaintProperty('travel-countries-fill', 'fill-color'),
      zoom: map.getZoom(), center: map.getCenter().toArray() };
  }, STORAGE_KEY);
  expect(after.data).toBe(before.data);
  expect(after.fill).toEqual(before.fill);
  expect(after.zoom).toBeCloseTo(before.zoom, 5);
  expect(after.center[0]).toBeCloseTo(before.center[0], 5);
  expect(after.center[1]).toBeCloseTo(before.center[1], 5);
  await page.reload();
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(key => localStorage.getItem(key), THEME_KEY)).toBe('dark');
  await page.getByRole('button', { name: 'Включить светлую тему', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.evaluate(() =>
    (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap.getPaintProperty('background', 'background-color'),
  )).toEqual(before.background);
});

test('the new country controls stay reachable in both themes and dark panel text retains contrast', async ({ page }, testInfo) => {
  await forceLight(page);
  await boot(page);
  if (testInfo.project.name === 'desktop') await expect(page.locator('.journey-overview')).toBeVisible();
  await selectCountry(page);
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
    for (const control of [page.getByRole('button', { name: 'Добавить посещение', exact: true }), page.getByLabel('Свой цвет страны', { exact: true }), page.locator('.theme-toggle')]) {
      await control.scrollIntoViewIfNeeded();
      const target = await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { width: box.width, height: box.height, reachable: hit === element || element.contains(hit) };
      });
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.reachable).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`country-editor-${theme}.png`), animations: 'disabled' });
  }
  const contrasts = await page.locator('.country-editor .hint').evaluateAll(elements => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: number[]) => color.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const background = luminance(rgb(getComputedStyle(document.querySelector('#travel-panel')!).backgroundColor));
    return elements.map(element => {
      const foreground = luminance(rgb(getComputedStyle(element).color));
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
  });
  expect(contrasts.length).toBeGreaterThan(0);
  for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
});
