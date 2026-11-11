import { expect, test } from '@playwright/test';
import { boot, city, openCities, openSearch, seed, type MapRoot } from './helpers';

test('the home exposes travel actions and a summary without technical tools; panels are exclusive', async ({ page }, testInfo) => {
  await boot(page);
  await expect(page.getByRole('button', { name: 'Добавить место', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Мои места', exact: true })).toBeVisible();
  await expect(page.locator('#travel-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Экспорт|Импорт|Ставить флажки|Закрашивать страны|Город вручную/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"], input[type="color"], input[type="number"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('casual-home.png') });
  await openSearch(page);
  await expect(page.getByLabel('Страна или город', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#travel-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Добавить место', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Мои места', exact: true }).click();
  const tabs = page.getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#travel-panel')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('existing visits share one marker, marker activation edits and the far hemisphere hides it', async ({ page }) => {
  await seed(page, { schemaVersion: 1, countryColors: {}, cities: [city({
    visits: [
      { id: 'first', date: '2024-01-01', note: 'Первый визит' },
      { id: 'second', date: '2025-01-01', note: 'Второй визит' },
    ],
  })] });
  await boot(page);
  const marker = page.getByTestId('city-marker-fixture-paris');
  await expect(page.locator('.travel-map__marker[data-city-id]')).toHaveCount(1);
  await page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    map.stop(); map.jumpTo({ center: [2.35, 48.85], zoom: 3 });
  });
  await expect(marker).toHaveAttribute('data-occluded', 'false');
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Название места', { exact: true })).toHaveValue('Париж');
  await expect(page.getByLabel('Заметка', { exact: true }).first()).toHaveValue('Второй визит');
  await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  await page.evaluate(() => {
    const map = (document.querySelector('[data-testid="travel-map"]') as MapRoot).__travelMap;
    map.stop(); map.jumpTo({ center: [-177.65, -48.85], zoom: 1.8 });
  });
  await expect(marker).toHaveAttribute('data-occluded', 'true');
  await expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(await marker.evaluate(element => {
    const style = getComputedStyle(element);
    return { visibility: style.visibility, pointerEvents: style.pointerEvents, tabIndex: (element as HTMLElement).tabIndex };
  })).toEqual({ visibility: 'hidden', pointerEvents: 'none', tabIndex: -1 });
  await openCities(page);
  await expect(page.locator('[data-city-list-id]')).toHaveCount(1);
});
