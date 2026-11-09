import { expect, test } from '@playwright/test';
import { boot, city, nominatimPlace, openCities, openSearch, persisted, saveCity, seed, selectCountry, STORAGE_KEY, stubMap } from './helpers';

test('one-action country marking persists and can be removed without adding places', async ({ page }) => {
  await boot(page);
  await selectCountry(page);
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  await expect.poll(() => persisted(page)).toMatchObject({ countryColors: { FR: '#C45B3D' }, cities: [] });
  await page.reload();
  await selectCountry(page);
  await expect(page.getByRole('button', { name: 'Отмечено', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Убрать отметку', exact: true }).click();
  await expect.poll(() => persisted(page)).toMatchObject({ countryColors: {}, cities: [] });
});

test('typing does not geocode, Enter searches and saving preserves safe text and calendar dates', async ({ page }) => {
  let calls = 0;
  await page.route('https://nominatim.openstreetmap.org/**', route => { calls++; return route.fulfill({ json: [nominatimPlace()] }); });
  await boot(page);
  await openSearch(page);
  const input = page.getByLabel('Страна или город', { exact: true });
  await input.fill('Париж');
  await page.waitForTimeout(700);
  expect(calls).toBe(0);
  await input.press('Enter');
  await page.getByRole('list', { name: 'Результаты поиска города' }).getByRole('button').click();
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Париж');
  await page.getByLabel('Дата посещения', { exact: true }).fill('2024-02-29');
  await page.getByLabel('Заметка', { exact: true }).fill('<script>alert("text")</script>');
  await saveCity(page);
  expect(calls).toBe(1);
  const data = await persisted(page);
  expect(data.countryColors).toEqual({});
  expect(data.cities).toHaveLength(1);
  expect(data.cities[0].visits[0]).toMatchObject({ date: '2024-02-29', note: '<script>alert("text")</script>' });
  await page.reload();
  await openCities(page);
  await page.locator('[data-city-list-id]').click();
  await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('<script>alert("text")</script>');
});

test('existing colors and all earlier visits survive editing the latest memory', async ({ page }) => {
  const visits = [
    { id: 'old-1', date: '2020-05-01', note: 'Старое воспоминание' },
    { id: 'old-2', date: '2025-08-15', note: 'Последнее воспоминание' },
  ];
  await seed(page, { schemaVersion: 1, countryColors: { FR: '#9B6EF3', KZ: '#48A9A6' }, cities: [city({ visits })] });
  await boot(page);
  await openCities(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
  await expect(page.getByLabel('Заметка', { exact: true }).first()).toHaveValue('Последнее воспоминание');
  await page.getByLabel('Заметка', { exact: true }).first().fill('Обновлённое воспоминание');
  await saveCity(page);
  const data = await persisted(page);
  expect(data.countryColors).toEqual({ FR: '#9B6EF3', KZ: '#48A9A6' });
  expect(data.cities[0].visits).toHaveLength(2);
  expect(data.cities[0].visits[0]).toEqual(visits[0]);
  expect(data.cities[0].visits[1]).toEqual({ ...visits[1], note: 'Обновлённое воспоминание' });
});

test('corrupt data is preserved until confirmed recovery and backed up before resetting', async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, '{broken');
  }, STORAGE_KEY);
  await boot(page);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{broken');
  await page.reload();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{broken');
  await expect(page.getByRole('button', { name: /Экспорт|Импорт/ })).toHaveCount(0);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Начать заново', exact: true }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{broken');
  await expect(page.getByRole('alert')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Начать заново', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await persisted(page)).toEqual({ schemaVersion: 1, countryColors: {}, cities: [] });
  const recoveryCopies = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('travel-tracker:recovery:')));
  expect(recoveryCopies).toHaveLength(1);
  expect(recoveryCopies[0][1]).toBe('{broken');
  await page.reload();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await selectCountry(page);
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  await expect.poll(() => persisted(page)).toMatchObject({ countryColors: { FR: '#C45B3D' } });
});

test('failed recovery backup never overwrites the damaged original', async ({ page }) => {
  await page.addInitScript(key => {
    const originalSet = Storage.prototype.setItem;
    originalSet.call(localStorage, key, '{broken');
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey.startsWith('travel-tracker:recovery:')) {
        (window as Window & { recoveryAttempted?: boolean }).recoveryAttempted = true;
        throw new DOMException('Test recovery quota exceeded', 'QuotaExceededError');
      }
      return originalSet.call(this, storageKey, value);
    };
  }, STORAGE_KEY);
  await boot(page);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Начать заново', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(
    (window as Window & { recoveryAttempted?: boolean }).recoveryAttempted,
  ))).toBe(true);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{broken');
  await expect(page.getByRole('button', { name: 'Добавить место', exact: true })).toBeDisabled();
});

test('concurrent tabs keep the winning snapshot and expose reload for the stale tab', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([stubMap(page), stubMap(second)]);
  await Promise.all([page.goto('/'), second.goto('/')]);
  await Promise.all([selectCountry(page, 'Франция'), selectCountry(second, 'Казахстан')]);
  await page.getByRole('button', { name: 'Я здесь был', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Загрузить изменения', exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Я здесь был', exact: true })).toBeDisabled();
  expect((await persisted(second)).countryColors).toEqual({ FR: '#C45B3D' });
  await second.getByRole('button', { name: 'Загрузить изменения', exact: true }).click();
  await expect(second.getByRole('alert')).toHaveCount(0);
  await second.close();
});
