import { expect, test } from '@playwright/test';
import type { TrackerData } from '../../src/domain/types';
import { boot, clickMapPoint, city as seededCity, nominatimPlace, openCities, persisted, saveCity, searchResult, seed, STORAGE_KEY } from './helpers';
type TestWindow = Window & { __travelDataWritesBlocked?: boolean };

test('late reverse preserves manual fields and cannot overwrite another open city', async ({ page }) => {
  test.setTimeout(60_000);
  const releases: Array<() => void> = [];
  const delivered: Array<Promise<void>> = [];
  let reverseCalls = 0;
  await page.route('https://nominatim.openstreetmap.org/**', async route => {
    const url = new URL(route.request().url());
    expect(url.pathname).toBe('/reverse');
    const index = reverseCalls++;
    let complete!: () => void;
    delivered[index] = new Promise<void>(resolve => { complete = resolve; });
    await new Promise<void>(resolve => { releases[index] = resolve; });
    try {
      await route.fulfill({ json: nominatimPlace(201 + index, index ? 'Лион' : 'Париж', Number(url.searchParams.get('lon')), Number(url.searchParams.get('lat'))) });
    } catch {
      // Closing the draft aborts fetch; an already-aborted routed request may reject fulfilment.
    } finally { complete(); }
  });
  try {
    await boot(page);
    await clickMapPoint(page, [2.35, 48.85]);
    await expect.poll(() => reverseCalls).toBe(1);
    await page.getByLabel('Название места', { exact: true }).fill('Моё название города');
    await page.getByLabel('Дата посещения').fill('2024-02-29');
    await page.getByLabel('Заметка', { exact: true }).fill('Заметка до ответа геокодера');
    releases[0]();
    await delivered[0];
    await expect(page.getByRole('status').filter({ hasText: 'Определяем' })).toHaveCount(0);
    await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Моё название города');
    await expect(page.getByLabel('Дата посещения')).toHaveValue('2024-02-29');
    await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('Заметка до ответа геокодера');
    await saveCity(page);
    const saved = (await persisted(page)).cities[0];
    expect(saved.name).toBe('Моё название города');
    expect(saved.coordinates[0]).toBeCloseTo(2.35, 4);
    expect(saved.coordinates[1]).toBeCloseTo(48.85, 4);

    await clickMapPoint(page, [4.83, 45.76]);
    await expect.poll(() => reverseCalls).toBe(2);
    await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
    await openCities(page);
    await page.locator(`[data-city-list-id="${saved.id}"]`).click();
    releases[1]();
    await delivered[1];
    await expect(page.getByLabel('Название места', { exact: true })).toHaveValue(saved.name);
    await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue(saved.visits[0].note);
    expect((await persisted(page)).cities).toEqual([saved]);
    await expect(page.getByTestId('draft-city-marker')).toHaveCount(0);
  } finally {
    for (const release of releases) release?.();
  }
});

test('a failed reverse request still permits a complete manual city save', async ({ page }) => {
  let calls = 0;
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    calls++;
    return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' });
  });
  await boot(page);
  await clickMapPoint(page, [76.9, 43.2]);
  await expect(page.getByRole('status').filter({ hasText: /название вручную/i })).toBeVisible();
  await page.getByLabel('Название места', { exact: true }).fill('Алматы вручную');
  await page.getByLabel('Дата посещения').fill('2026-01-01');
  await page.getByLabel('Заметка', { exact: true }).fill('Сервис недоступен, воспоминание сохранено');
  await saveCity(page);
  const data = await persisted(page);
  expect(calls).toBe(1);
  expect(data.countryColors).toEqual({});
  expect(data.cities).toHaveLength(1);
  expect(data.cities[0].name).toBe('Алматы вручную');
  expect(data.cities[0].coordinates[0]).toBeCloseTo(76.9, 4);
  expect(data.cities[0].coordinates[1]).toBeCloseTo(43.2, 4);
  expect(data.cities[0].visits[0]).toMatchObject({ date: '2026-01-01', note: 'Сервис недоступен, воспоминание сохранено' });
  await page.reload();
  await openCities(page);
  await page.locator(`[data-city-list-id="${data.cities[0].id}"]`).click();
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Алматы вручную');
  await expect(page.getByLabel('Дата посещения')).toHaveValue('2026-01-01');
});

test('ambiguous OSM matches support merging aliases and explicitly distinct same-name cities', async ({ page }) => {
  test.setTimeout(60_000);
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [seededCity({ osmRefs: ['node:101'] })] });
  let calls = 0;
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    const url = new URL(route.request().url());
    expect(url.pathname).toBe('/search');
    calls++;
    const different = url.searchParams.get('q')?.includes('другой');
    return route.fulfill({ json: [nominatimPlace(different ? 303 : 202)] });
  });
  await boot(page);
  await searchResult(page, 'Париж Франция');
  await expect(page.getByLabel('Возможное совпадение города')).toBeVisible();
  await page.getByLabel('Дата посещения').fill('2026-01-01');
  await page.getByLabel('Заметка', { exact: true }).fill('Второй визит через relation');
  await page.getByRole('button', { name: 'Объединить с местом: Париж · Иль-де-Франс', exact: true }).click();
  await saveCity(page);
  let data = await persisted(page);
  expect(data.cities).toHaveLength(1);
  expect(data.cities[0].osmRefs).toEqual(['node:101', 'relation:202']);
  expect(data.cities[0].visits).toHaveLength(2);
  expect(data.cities[0].visits[1]).toMatchObject({ date: '2026-01-01', note: 'Второй визит через relation' });

  await page.reload();
  await searchResult(page, 'Париж Франция');
  await expect(page.getByLabel('Возможное совпадение города')).toHaveCount(0);
  await expect(page.getByLabel('Дата посещения', { exact: true }).first()).toHaveValue('2026-01-01');
  expect(calls).toBe(1); // A saved alias and the persistent cache survive reload.
  await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();

  await searchResult(page, 'Париж другой');
  await expect(page.getByLabel('Возможное совпадение города')).toBeVisible();
  await page.getByRole('button', { name: 'Это другое место', exact: true }).click();
  await page.getByLabel('Заметка', { exact: true }).fill('Отдельное место с таким же названием');
  await saveCity(page);
  data = await persisted(page);
  expect(data.cities).toHaveLength(2);
  expect(new Set(data.cities.map(city => city.id)).size).toBe(2);
  expect(data.cities.map(city => city.name)).toEqual(['Париж', 'Париж']);
  expect(data.cities.find(city => city.id === 'fixture-paris')!.visits).toHaveLength(2);
  const distinct = data.cities.find(city => city.id !== 'fixture-paris')!;
  expect(distinct.osmRefs).toEqual(['relation:303']);
  expect(distinct.visits).toHaveLength(1);
  const refs = data.cities.flatMap(city => city.osmRefs);
  expect(new Set(refs).size).toBe(refs.length);
  expect(data.countryColors).toEqual({});
  await page.reload();
  await openCities(page);

  await expect(page.locator('[data-city-list-id]')).toHaveCount(2);
});

test('quota failure preserves in-memory changes and retry saves the complete collection', async ({ page }) => {
  const original: TrackerData = {
    schemaVersion: 1, countryColors: { JP: '#46A88C' },
    cities: [seededCity({ id: 'fixture-kyoto', name: 'Киото', coordinates: [135.77, 35.01], countryCode: 'JP', localityName: 'Киото', regionName: 'Киото', osmRefs: [] })],
  };
  await page.addInitScript(({ key, original }) => {
    const originalSet = Storage.prototype.setItem;
    if (localStorage.getItem(key) === null) originalSet.call(localStorage, key, JSON.stringify(original));
    (window as TestWindow).__travelDataWritesBlocked = true;
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey === key && (window as TestWindow).__travelDataWritesBlocked) {
        throw new DOMException('Test quota exceeded', 'QuotaExceededError');
      }
      return originalSet.call(this, storageKey, value);
    };
  }, { key: STORAGE_KEY, original });
  await boot(page);
  await openCities(page);
  await page.locator('[data-city-list-id="fixture-kyoto"]').click();
  await page.getByLabel('Заметка', { exact: true }).fill('Изменение пока только в памяти');
  await saveCity(page);
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить');
  expect(await persisted(page)).toEqual(original);
  await openCities(page);
  await page.locator('[data-city-list-id="fixture-kyoto"]').click();
  await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('Изменение пока только в памяти');
  await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  await page.evaluate(() => { (window as TestWindow).__travelDataWritesBlocked = false; });
  await page.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const saved = await persisted(page);
  expect(saved.cities[0].visits[0].note).toBe('Изменение пока только в памяти');
  expect(saved.countryColors).toEqual(original.countryColors);
});

