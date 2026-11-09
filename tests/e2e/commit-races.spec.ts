import { expect, test, type Page } from '@playwright/test';
import { boot, city, openCities, persisted, seed } from './helpers';

type LockWindow = Window & { releaseTrackerWrite?: () => void };
async function holdWriteLock(page: Page) {
  await page.evaluate(() => new Promise<void>(acquired => {
    void navigator.locks.request('travel-tracker:write:v1', () => new Promise<void>(release => {
      (window as LockWindow).releaseTrackerWrite = release;
      acquired();
    }));
  }));
}
async function releaseWriteLock(page: Page) {
  await page.evaluate(() => { (window as LockWindow).releaseTrackerWrite?.(); });
}
test.beforeEach(async ({ page }) => {
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [city()] });
  await boot(page);
  await openCities(page);
  await page.locator('[data-city-list-id="fixture-paris"]').click();
});
test('queued save freezes edits and refuses Escape until the snapshot is saved', async ({ page }) => {
  await page.getByLabel('Заметка', { exact: true }).fill('Заметка перед записью');
  await holdWriteLock(page);
  try {
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(page.getByLabel('Название места', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Закрыть редактор', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Заметка', { exact: true })).toBeVisible();
    expect((await persisted(page)).cities[0].visits[0].note).toBe('Первое путешествие');
  } finally { await releaseWriteLock(page); }
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
  expect((await persisted(page)).cities[0].visits[0].note).toBe('Заметка перед записью');
});
test('queued deletion cannot close the editor before the write completes', async ({ page }) => {
  await holdWriteLock(page);
  try {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Удалить место', exact: true }).click();
    await expect(page.getByLabel('Название места', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Название места', { exact: true })).toBeVisible();
    expect((await persisted(page)).cities).toHaveLength(1);
  } finally { await releaseWriteLock(page); }
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
  expect((await persisted(page)).cities).toEqual([]);
});
test('closing a dirty memory asks before discarding and returns focus to a visible control', async ({ page }) => {
  await page.getByLabel('Заметка', { exact: true }).fill('Несохранённое');
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Заметка', { exact: true })).toHaveValue('Несохранённое');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
  expect((await persisted(page)).cities[0].visits[0].note).toBe('Первое путешествие');
  expect(await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const rect = element.getBoundingClientRect();
    return element !== document.body && rect.width > 0 && rect.height > 0;
  })).toBe(true);
});
