import { expect, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { City, TrackerData } from '../../src/domain/types';

export const STORAGE_KEY = 'travel-tracker:data:v1';
export type MapRoot = HTMLElement & { __travelMap: MapLibreMap };
export const LOCAL_STYLE = {
  version: 8, sources: { fixture: {
    type: 'geojson', data: { type: 'FeatureCollection', features: [] },
    attribution: 'OpenFreeMap · OpenMapTiles · OpenStreetMap',
  } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#eaf0f2' } },
    { id: 'fixture-fill', type: 'fill', source: 'fixture', paint: { 'fill-color': '#eaf0f2' } },
  ],
};
export function city(overrides: Partial<City> = {}): City {
  return {
    id: 'fixture-paris', name: 'Париж', coordinates: [2.35, 48.85], countryCode: 'FR',
    localityName: 'Париж', regionName: 'Иль-де-Франс', osmRefs: ['relation:101'],
    visits: [{ id: 'fixture-visit', date: '2024-02-29', note: 'Первое путешествие' }], ...overrides,
  };
}
export function nominatimPlace(id = 101, name = 'Париж', longitude = 2.35, latitude = 48.85) {
  return {
    osm_type: 'relation', osm_id: id, lon: String(longitude), lat: String(latitude),
    name, display_name: name + ', Франция', addresstype: 'city', type: 'administrative',
    address: { city: name, country_code: 'fr', state: 'Иль-де-Франс' },
    namedetails: { 'name:ru': name },
  };
}
export async function stubMap(page: Page) {
  await page.route('https://tiles.openfreemap.org/**', route =>
    route.request().url().includes('/styles/liberty')
      ? route.fulfill({ json: LOCAL_STYLE }) : route.abort());
}
export async function seed(page: Page, data: TrackerData) {
  await page.addInitScript(({ key, data }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(data));
  }, { key: STORAGE_KEY, data });
}
export async function ready(page: Page) {
  await expect(page.getByTestId('travel-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 20_000 });
}
export async function boot(page: Page) { await stubMap(page); await page.goto('/'); await ready(page); }
export async function persisted(page: Page): Promise<TrackerData> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
}
export async function openSearch(page: Page) {
  await page.getByRole('button', { name: 'Добавить место', exact: true }).click();
  await expect(page.getByLabel('Страна или город', { exact: true })).toBeVisible();
}
export async function selectCountry(page: Page, name = 'Франция') {
  await openSearch(page);
  await page.getByLabel('Страна или город', { exact: true }).fill(name);
  await page.getByRole('button', { name, exact: true }).click();
}
export async function searchResult(page: Page, query = 'Париж') {
  await openSearch(page);
  await page.getByLabel('Страна или город', { exact: true }).fill(query);
  await page.getByRole('button', { name: 'Найти город', exact: true }).click();
  await page.getByRole('list', { name: 'Результаты поиска города' }).getByRole('button').first().click();
}
export async function openCities(page: Page) {
  await page.getByRole('button', { name: 'Мои места', exact: true }).click();
  await page.getByRole('tab', { name: /^Места/ }).click();
}
export async function saveCity(page: Page) {
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByLabel('Название места', { exact: true })).toHaveCount(0);
}
export async function clickMapPoint(page: Page, coordinates: [number, number]) {
  await openSearch(page);
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
    const p = map.project(coordinates), rect = map.getCanvas().getBoundingClientRect();
    const x = p.x + rect.left, y = p.y + rect.top;
    return { x, y, unobstructed: document.elementFromPoint(x, y) === map.getCanvas() };
  }, coordinates);
  expect(point.unobstructed).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel('Название места', { exact: true })).toBeVisible();
}
