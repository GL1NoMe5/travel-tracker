import { expect, test, type Page } from '@playwright/test';
import type { City } from '../../src/domain/types';
import { boot, city, nominatimPlace, openCities, persisted, ready, saveCity, searchResult, seed, STORAGE_KEY, type MapRoot } from './helpers';

function wish(overrides: Partial<City> = {}): City {
  return city({ status: 'wishlist', wishNote: 'Погулять вдоль Сены', visits: [], ...overrides });
}

async function openWishlist(page: Page) {
  await page.getByRole('button', { name: 'Хочу посетить', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Хочу посетить/ })).toHaveAttribute('aria-selected', 'true');
}

async function addWish(page: Page) {
  await openWishlist(page);
  await page.getByRole('button', { name: 'Добавить желание', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Статус места', exact: true })
    .getByRole('button', { name: 'Хочу посетить', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function searchWish(page: Page, query = 'Париж') {
  await addWish(page);
  await page.getByLabel('Город или место', { exact: true }).fill(query);
  await page.getByLabel('Город или место', { exact: true }).press('Enter');
  await page.getByRole('list', { name: 'Результаты поиска места', exact: true }).getByRole('button').first().click();
}

async function clickWishPoint(page: Page, coordinates: [number, number]) {
  await addWish(page);
  await page.getByRole('button', { name: /^Выбрать на карте/ }).click();
  await page.evaluate(async coordinates => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    map.stop();
    await new Promise<void>(resolve => {
      map.once('idle', () => resolve());
      map.jumpTo({ center: coordinates, zoom: 7, bearing: 0, pitch: 0 });
      map.triggerRepaint();
    });
  }, coordinates);
  const point = await page.evaluate(coordinates => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    const point = map.project(coordinates), rect = map.getCanvas().getBoundingClientRect();
    const x = point.x + rect.left, y = point.y + rect.top;
    return { x, y, clear: document.elementFromPoint(x, y) === map.getCanvas() };
  }, coordinates);
  expect(point.clear).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel('Название места', { exact: true })).toBeVisible();
}

test('a searched wish persists as a heart without changing visited statistics or earlier memories', async ({ page }) => {
  const earlier = city({ id: 'old-lyon', name: 'Лион', localityName: 'Лион', coordinates: [4.83, 45.76], osmRefs: ['relation:202'] });
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#C45B3D' }, countryVisits: { FR: 3 }, cities: [earlier] });
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [nominatimPlace()] }));
  await boot(page);
  await searchWish(page);
  await expect(page.getByLabel('Дата посещения', { exact: true })).toHaveCount(0);
  await page.getByLabel('Заметка', { exact: true }).fill('Посетить музей <script>без исполнения</script>');
  await expect(page.getByTestId('draft-city-marker')).toHaveAttribute('data-place-status', 'wishlist');
  await saveCity(page);
  const saved = (await persisted(page)).cities.find(item => item.id !== earlier.id)!;
  expect(saved).toMatchObject({ name: 'Париж', status: 'wishlist', visits: [], wishNote: 'Посетить музей <script>без исполнения</script>' });
  expect((await persisted(page)).cities.find(item => item.id === earlier.id)).toEqual(earlier);
  expect((await persisted(page)).countryVisits).toEqual({ FR: 3 });
  expect((await persisted(page)).countryColors).toEqual({ FR: '#C45B3D' });
  await expect(page.getByTestId(`city-marker-${saved.id}`)).toHaveClass(/travel-map__marker--wishlist/);
  await expect(page.getByTestId(`city-marker-${saved.id}`)).toHaveAttribute('aria-label', 'Место Париж: хочу посетить');
  await page.reload();
  await ready(page);
  await openWishlist(page);
  await expect(page.locator('[data-city-list-id]')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /^Места/ })).toContainText('1');
  await expect(page.getByRole('tab', { name: /^Хочу посетить/ })).toContainText('1');
  await page.locator(`[data-city-list-id="${saved.id}"]`).click();
  await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue(saved.wishNote!);
  await expect(page.getByLabel('Дата посещения', { exact: true })).toHaveCount(0);
});

test('a map wish can be named and saved manually when reverse geocoding is unavailable', async ({ page }) => {
  let requests = 0;
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    requests++;
    expect(new URL(route.request().url()).pathname).toBe('/reverse');
    return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' });
  });
  await boot(page);
  await clickWishPoint(page, [76.9, 43.2]);
  await expect(page.getByRole('status').filter({ hasText: /название вручную/i })).toBeVisible();
  await page.getByLabel('Название места', { exact: true }).fill('Место для пикника');
  await page.getByLabel('Заметка', { exact: true }).fill('Приехать на рассвете');
  await saveCity(page);
  const data = await persisted(page);
  expect(requests).toBe(1);
  expect(data.countryColors).toEqual({});
  expect(data.cities).toHaveLength(1);
  expect(data.cities[0]).toMatchObject({ name: 'Место для пикника', status: 'wishlist', visits: [], wishNote: 'Приехать на рассвете' });
  expect(data.cities[0].coordinates[0]).toBeCloseTo(76.9, 4);
  expect(data.cities[0].coordinates[1]).toBeCloseTo(43.2, 4);
  await openWishlist(page);
  await expect(page.getByRole('tab', { name: /^Места/ })).toContainText('0');
  await expect(page.getByRole('tab', { name: /^Страны/ })).toContainText('0');
});

test('marking a wish as visited preserves its identity, note and country counts without another marker', async ({ page }) => {
  const planned = wish();
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#46A88C' }, countryVisits: { FR: 2 }, cities: [planned] });
  await boot(page);
  await openWishlist(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  await page.getByRole('button', { name: 'Отметить посещённым', exact: true }).click();
  await expect(page.getByLabel('Заметка', { exact: true }).first()).toHaveValue(planned.wishNote!);
  await page.getByLabel('Дата посещения', { exact: true }).first().fill('2026-11-11');
  await saveCity(page);
  const data = await persisted(page);
  expect(data.cities).toHaveLength(1);
  expect(data.cities[0]).toMatchObject({ id: planned.id, status: 'visited', coordinates: planned.coordinates, osmRefs: planned.osmRefs,
    visits: [{ date: '2026-11-11', note: planned.wishNote }] });
  expect(data.cities[0].wishNote).toBeUndefined();
  expect(data.countryVisits).toEqual({ FR: 2 });
  await expect(page.getByTestId(`city-marker-${planned.id}`)).toHaveAttribute('data-place-status', 'visited');
  await expect(page.getByTestId(`city-marker-${planned.id}`)).not.toHaveClass(/travel-map__marker--wishlist/);
  await expect(page.locator('[data-city-id]')).toHaveCount(1);
  await page.reload();
  await ready(page);
  await openWishlist(page);
  await expect(page.locator('[data-city-list-id]')).toHaveCount(0);
  await page.getByRole('tab', { name: /^Места/ }).click();
  await expect(page.locator('[data-city-list-id]')).toHaveCount(1);
});

test('searching an already visited OSM place from the wishlist preserves its existing history', async ({ page }) => {
  const existing = city({ visits: [
    { id: 'history-one', date: '2024-02-29', note: 'Первое посещение' },
    { id: 'history-two', date: '2025-03-08', note: 'Второе посещение' },
  ] });
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [existing] });
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [nominatimPlace()] }));
  await boot(page);
  await searchWish(page);
  await expect(page.getByLabel('Дата посещения', { exact: true }).first()).toHaveValue('2025-03-08');
  await saveCity(page);
  expect((await persisted(page)).cities).toEqual([existing]);
  await expect(page.locator('[data-city-id]')).toHaveCount(1);
});

test('dirty wishes require discard confirmation and queued saves freeze edits until the lock is released', async ({ page }) => {
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [wish()] });
  await boot(page);
  await openWishlist(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  await page.getByLabel('Заметка', { exact: true }).fill('Планы, которые ещё не сохранены');
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('Планы, которые ещё не сохранены');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  expect((await persisted(page)).cities[0].wishNote).toBe('Погулять вдоль Сены');
  await openWishlist(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  await page.getByLabel('Заметка', { exact: true }).fill('Сохранённый план');
  await page.evaluate(() => new Promise<void>(acquired => {
    void navigator.locks.request('travel-tracker:write:v1', () => new Promise<void>(release => {
      (window as Window & { releaseWishLock?: () => void }).releaseWishLock = release;
      acquired();
    }));
  }));
  try {
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.getByLabel('Название места', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Отметить посещённым', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Закрыть редактор', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Заметка', { exact: true })).toBeVisible();
    expect((await persisted(page)).cities[0].wishNote).toBe('Погулять вдоль Сены');
  } finally {
    await page.evaluate(() => (window as Window & { releaseWishLock?: () => void }).releaseWishLock?.());
  }
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
  expect((await persisted(page)).cities[0]).toMatchObject({ status: 'wishlist', visits: [], wishNote: 'Сохранённый план' });
});

test('wishlist tabs support the keyboard and deleting a wish leaves visited places intact', async ({ page }) => {
  const visited = city({ id: 'visited-lyon', name: 'Лион', localityName: 'Лион', osmRefs: ['relation:202'] });
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [visited, wish()] });
  await boot(page);
  await openWishlist(page);
  const wishes = page.getByRole('tab', { name: /^Хочу посетить/ });
  const countries = page.getByRole('tab', { name: /^Страны/ });
  const places = page.getByRole('tab', { name: /^Места/ });
  await wishes.focus();
  await page.keyboard.press('ArrowRight');
  await expect(countries).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(places).toBeFocused();
  await page.keyboard.press('End');
  await expect(wishes).toBeFocused();
  await page.keyboard.press('Home');
  await expect(countries).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(wishes).toBeFocused();
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Удалить место', exact: true }).click();
  expect((await persisted(page)).cities).toHaveLength(2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Удалить место', exact: true }).click();
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
  expect((await persisted(page)).cities).toEqual([visited]);
  await expect(page.getByTestId('city-marker-fixture-paris')).toHaveCount(0);
});

test('wishlist entry, editor and hearts stay reachable and distinct in both themes', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [wish()] });
  await boot(page);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
    const entry = page.getByRole('button', { name: 'Хочу посетить', exact: true });
    await expect(entry).toBeVisible();
    await openWishlist(page);
    await expect(page.getByRole('button', { name: 'Добавить желание', exact: true })).toBeVisible();
    await page.locator('[data-city-list-id="fixture-paris"]').click();
    for (const control of [page.getByRole('button', { name: 'Отметить посещённым', exact: true }), page.getByRole('button', { name: 'Сохранить', exact: true }), page.locator('.theme-toggle')]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { width: rect.width, height: rect.height, reachable: hit === element || element.contains(hit) };
      });
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.reachable).toBe(true);
    }
    await expect(page.getByTestId('city-marker-fixture-paris')).toHaveClass(/travel-map__marker--wishlist/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`wishlist-${theme}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  }
  await openCities(page);
  await expect(page.locator('[data-city-list-id]')).toHaveCount(0);
});

test('marker colors apply to every saved and draft marker, persist independently and keep black and white shapes outlined', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#46A88C' }, countryVisits: { FR: 2 }, cities: [
    city(),
    city({ id: 'visited-lyon', name: 'Лион', localityName: 'Лион', coordinates: [4.83, 45.76], osmRefs: ['relation:202'], visits: [{ id: 'lyon-visit', date: null, note: '' }] }),
    wish({ id: 'wish-rome', name: 'Рим', localityName: 'Рим', coordinates: [12.5, 41.9], osmRefs: ['relation:303'] }),
    wish({ id: 'wish-tokyo', name: 'Токио', localityName: 'Токио', coordinates: [139.7, 35.7], osmRefs: ['relation:404'] }),
  ] });
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [nominatimPlace(505, 'Ницца', 7.27, 43.7)] }));
  await boot(page);
  const original = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await openWishlist(page);
  await page.getByText('Цвет отметок', { exact: true }).click();
  const visitedPicker = page.getByLabel('Цвет посещённых мест', { exact: true });
  const wishPicker = page.getByLabel('Цвет желаний', { exact: true });
  const defaults = { visited: await visitedPicker.inputValue(), wishlist: await wishPicker.inputValue() };
  await visitedPicker.fill('#000000');
  await wishPicker.fill('#ffffff');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Включить тёмную тему', exact: true }).click();
    const flags = page.locator('[data-city-id][data-place-status="visited"] .travel-map__marker-pin');
    const hearts = page.locator('[data-city-id][data-place-status="wishlist"] .travel-map__marker-pin');
    await expect(flags).toHaveCount(2);
    await expect(hearts).toHaveCount(2);
    for (const flag of await flags.all()) {
      await expect(flag).toHaveCSS('background-color', 'rgb(0, 0, 0)');
      await expect(flag).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(flag).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
    }
    for (const heart of await hearts.all()) {
      await expect(heart).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(heart.locator('svg')).toHaveCSS('fill', 'rgb(255, 255, 255)');
      await expect(heart.locator('svg')).toHaveCSS('stroke', 'rgb(23, 32, 38)');
    }
  }
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(original);
  await page.reload();
  await ready(page);
  await openWishlist(page);
  await page.getByText('Цвет отметок', { exact: true }).click();
  await expect(visitedPicker).toHaveValue('#000000');
  await expect(wishPicker).toHaveValue('#ffffff');
  await page.getByRole('button', { name: 'Добавить желание', exact: true }).click();
  await page.getByLabel('Город или место', { exact: true }).fill('Ницца');
  await page.getByLabel('Город или место', { exact: true }).press('Enter');
  await page.getByRole('list', { name: 'Результаты поиска места', exact: true }).getByRole('button').first().click();
  const draft = page.getByTestId('draft-city-marker');
  await expect(draft).toHaveAttribute('data-place-status', 'wishlist');
  await expect(draft.locator('.travel-map__marker-pin')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.getByRole('group', { name: 'Статус места', exact: true }).getByRole('button', { name: 'Уже посетил', exact: true }).click();
  await expect(draft).toHaveAttribute('data-place-status', 'visited');
  await expect(draft.locator('.travel-map__marker-pin')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  await openWishlist(page);
  await page.getByText('Цвет отметок', { exact: true }).click();
  await page.getByRole('button', { name: 'Вернуть цвета', exact: true }).click();
  await expect(visitedPicker).toHaveValue(defaults.visited);
  await expect(wishPicker).toHaveValue(defaults.wishlist);
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(original);
});

test('wishlist searches retain a park name and use unrestricted place search while visited search remains city-only', async ({ page }) => {
  const requests: URL[] = [];
  const park = {
    osm_type: 'way', osm_id: 606, lon: '2.337', lat: '48.846',
    name: 'Jardin du Luxembourg', display_name: 'Люксембургский сад, Париж, Франция',
    class: 'leisure', type: 'park', addresstype: 'leisure',
    address: { leisure: 'Люксембургский сад', city: 'Париж', country_code: 'fr', state: 'Иль-де-Франс' },
    namedetails: { 'name:ru': 'Люксембургский сад' },
  };
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    const url = new URL(route.request().url());
    requests.push(url);
    return route.fulfill({ json: [url.searchParams.has('featureType') ? nominatimPlace() : park] });
  });
  await boot(page);
  await searchWish(page, 'Люксембургский сад');
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Люксембургский сад');
  await saveCity(page);
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('featureType')).toBeNull();
  expect(requests[0].searchParams.get('layer')).toBeNull();
  expect((await persisted(page)).cities[0]).toMatchObject({ name: 'Люксембургский сад', status: 'wishlist', osmRefs: ['way:606'], coordinates: [2.337, 48.846], visits: [] });
  await searchResult(page, 'Париж');
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Париж');
  await expect(page.getByLabel('Возможное совпадение города')).toHaveCount(0);
  await expect(page.getByLabel('Дата посещения', { exact: true })).toBeVisible();
  await saveCity(page);
  expect(requests).toHaveLength(2);
  expect(requests[1].searchParams.get('featureType')).toBe('city');
  expect(requests[1].searchParams.get('layer')).toBe('address');
  const saved = (await persisted(page)).cities;
  expect(saved).toHaveLength(2);
  expect(saved.find(place => place.osmRefs.includes('way:606'))).toMatchObject({ status: 'wishlist', visits: [], name: 'Люксембургский сад' });
  expect(saved.find(place => place.osmRefs.includes('relation:101'))?.visits).toHaveLength(1);
});

for (const draftStatus of ['wishlist', 'visited'] as const) {
  test(`merging a ${draftStatus} draft with a saved wish refuses oversized notes without losing either and retries safely`, async ({ page }) => {
    const oldNote = 'А'.repeat(600);
    const draftNote = 'Б'.repeat(600);
    const savedWish = wish({ osmRefs: ['node:101'], wishNote: oldNote });
    await seed(page, { schemaVersion: 1, countryColors: {}, cities: [savedWish] });
    await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({ json: [nominatimPlace(202)] }));
    await boot(page);
    const original = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
    if (draftStatus === 'wishlist') await searchWish(page);
    else await searchResult(page);
    const matches = page.getByLabel('Возможное совпадение города');
    await expect(matches).toBeVisible();
    await page.getByLabel('Заметка', { exact: true }).fill(draftNote);
    const merge = page.getByRole('button', { name: 'Объединить с местом: Париж · Иль-де-Франс', exact: true });
    await merge.click();
    await expect(page.getByRole('alert')).toContainText('После объединения заметка длиннее 1000 символов. Сократите заметку перед объединением.');
    await expect(matches).toBeVisible();
    await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue(draftNote);
    await expect(page.getByTestId('draft-city-marker')).toHaveAttribute('data-place-status', draftStatus);
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(original);
    await page.getByLabel('Заметка', { exact: true }).fill('Короткое дополнение');
    await merge.click();
    await expect(matches).toHaveCount(0);
    await expect(page.getByLabel('Заметка', { exact: true }).first()).toHaveValue(`${oldNote}\n\nКороткое дополнение`);
    await saveCity(page);
    const data = await persisted(page);
    expect(data.cities).toHaveLength(1);
    expect(data.cities[0]).toMatchObject({ id: savedWish.id, status: draftStatus, osmRefs: ['node:101', 'relation:202'] });
    if (draftStatus === 'wishlist') {
      expect(data.cities[0].visits).toEqual([]);
      expect(data.cities[0].wishNote).toBe(`${oldNote}\n\nКороткое дополнение`);
    } else {
      expect(data.cities[0].visits).toHaveLength(1);
      expect(data.cities[0].visits[0]).toMatchObject({ date: null, note: `${oldNote}\n\nКороткое дополнение` });
      expect(data.cities[0].wishNote).toBeUndefined();
    }
    expect(data.countryColors).toEqual({});
    await expect(page.locator('.travel-map__marker[data-city-id]')).toHaveCount(1);
  });
}
