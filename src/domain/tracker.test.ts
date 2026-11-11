import { describe, expect, it } from 'vitest';
import { createCity, createEmptyData, createVisit, findCityMatch, getCountryVisitCount, getStats, isCalendarDate, markCityVisited, trackerReducer, validateTrackerData } from './tracker';
import type { PlaceCandidate } from './types';

const paris: PlaceCandidate = { name: 'Париж', displayName: 'Париж, Франция', coordinates: [2.35, 48.85], countryCode: 'FR', localityName: 'Париж', osmRef: 'node:123' };

describe('travel invariants', () => {
  it('counts cities independently from visits and colored countries', () => {
    const city = createCity(paris); city.visits.push(createVisit());
    const data = trackerReducer(createEmptyData(), { type: 'saveCity', city });
    expect(getStats(data)).toMatchObject({ cities: 1, countries: 0, visits: 2 });
    const colored = trackerReducer(data, { type: 'colorCountry', code: 'FR', color: '#abcdef' });
    expect(getStats(colored).countries).toBe(1);
    expect(trackerReducer(colored, { type: 'resetCountry', code: 'FR' }).cities).toEqual(data.cities);
  });
  it('editing a display name preserves identity and exact matching', () => {
    const city = { ...createCity(paris), name: 'Мой любимый город' };
    expect(findCityMatch([city], paris).exact?.id).toBe(city.id);
    expect(findCityMatch([city], { ...paris, osmRef: 'relation:321' }).suggestions).toHaveLength(1);
    expect(findCityMatch([city], { ...paris, osmRef: 'node:321', countryCode: 'US' }).suggestions).toHaveLength(0);
  });
  it('rejects an empty visit list and duplicate aliases across cities', () => {
    const first = createCity(paris); const second = createCity(paris);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...first, visits: [] }] })).toThrow();
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [first, second] })).toThrow(/OSM/);
  });
  it('rejects duplicate visit IDs and invalid geographic data', () => {
    const first = createCity(paris); const second = createCity({ ...paris, osmRef: undefined });
    second.visits = first.visits;
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [first, second] })).toThrow(/ID визитов/);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...first, coordinates: [181, 0] }] })).toThrow(/координаты/);
    expect(() => validateTrackerData({ ...createEmptyData(), countryColors: { XX: '#ffffff' } })).toThrow();
  });
  it('validates actual calendar dates without timezone conversion', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2025-02-29')).toBe(false);
    expect(isCalendarDate('2024-04-31')).toBe(false);
    const city = createCity(paris); city.visits[0].date = '2026-01-01';
    expect(validateTrackerData({ ...createEmptyData(), cities: [city] }).cities[0].visits[0].date).toBe('2026-01-01');
  });
  it('does not mutate earlier snapshots and drops unrecognized properties', () => {
    const initial = createEmptyData();
    const colored = trackerReducer(initial, { type: 'colorCountry', code: 'FR', color: '#abcdef' });
    expect(initial.countryColors).toEqual({});
    expect(colored.countryColors.FR).toBe('#ABCDEF');
    expect(validateTrackerData({ ...colored, unknown: 'discard' })).not.toHaveProperty('unknown');
  });
  it('reads old marked countries as one visit without changing saved colors or city history', () => {
    const city = createCity(paris);
    city.visits.push({ ...createVisit(), date: '2024-02-29', note: 'Старое воспоминание' });
    const legacy = { schemaVersion: 1 as const, countryColors: { FR: '#ABCDEF', KG: '#46A88C' }, cities: [city] };
    const canonical = validateTrackerData(legacy);
    expect(canonical.countryVisits).toEqual({ FR: 1, KG: 1 });
    expect(canonical.countryColors).toEqual(legacy.countryColors);
    expect(canonical.cities).toEqual(legacy.cities);
    expect(legacy).not.toHaveProperty('countryVisits');
    expect(getCountryVisitCount(legacy, 'FR')).toBe(1);
    expect(getCountryVisitCount(legacy, 'DE')).toBe(0);
  });
  it('counts country trips separately from countries, places, and city visits', () => {
    const city = createCity(paris); city.visits.push(createVisit());
    const places = trackerReducer(createEmptyData(), { type: 'saveCity', city });
    const first = trackerReducer(places, { type: 'setCountryVisits', code: 'KG', count: 3 });
    const second = trackerReducer(first, { type: 'setCountryVisits', code: 'FR', count: 2 });
    expect(second.countryColors.KG).toBe('#C45B3D');
    expect(getStats(second)).toMatchObject({ countries: 2, countryVisits: 5, cities: 1, visits: 2 });
    expect(first.countryVisits).toEqual({ KG: 3 });
    expect(places.countryColors).toEqual({});
    expect(second.cities).toEqual(places.cities);
  });
  it('preserves a trip count when recoloring and clears it only when the country is reset', () => {
    const initial = trackerReducer(createEmptyData(), { type: 'setCountryVisits', code: 'KG', count: 3 });
    const recolored = trackerReducer(initial, { type: 'colorCountry', code: 'KG', color: '#123456' });
    expect(recolored.countryVisits?.KG).toBe(3);
    const reset = trackerReducer(recolored, { type: 'resetCountry', code: 'KG' });
    expect(getCountryVisitCount(reset, 'KG')).toBe(0);
    expect(reset.countryVisits).toEqual({});
    expect(reset.countryColors).toEqual({});
    expect(trackerReducer(reset, { type: 'colorCountry', code: 'KG', color: '#abcdef' }).countryVisits?.KG).toBe(1);
    expect(recolored.countryVisits?.KG).toBe(3);
  });
  it.each([0, -1, 1.5, 1000, Number.NaN, Number.POSITIVE_INFINITY, '3', null])('rejects invalid country visit count %s', count => {
    expect(() => validateTrackerData({ ...createEmptyData(), countryColors: { KG: '#123456' }, countryVisits: { KG: count } })).toThrow(/Количество посещений/);
  });
  it('rejects country visits without a corresponding marked country and invalid count records', () => {
    expect(() => validateTrackerData({ ...createEmptyData(), countryVisits: { KG: 3 } })).toThrow(/неотмеченной/);
    expect(() => validateTrackerData({ ...createEmptyData(), countryVisits: { XX: 3 } })).toThrow(/Неизвестная страна/);
    expect(() => validateTrackerData({ ...createEmptyData(), countryVisits: null })).toThrow(/Посещения стран/);
    expect(() => validateTrackerData({ ...createEmptyData(), countryVisits: [] })).toThrow(/Посещения стран/);
    expect(trackerReducer(createEmptyData(), { type: 'setCountryVisits', code: 'KG', count: 999 }).countryVisits?.KG).toBe(999);
  });
});

describe('planned places', () => {
  it('keeps a plan out of visited statistics and preserves its distinct note', () => {
    const plan = { ...createCity(paris, 'wishlist'), wishNote: 'Хочу увидеть рассвет над Сеной' };
    const data = trackerReducer(createEmptyData(), { type: 'saveCity', city: plan });
    expect(data.cities[0]).toEqual(plan);
    expect(plan.visits).toEqual([]);
    expect(getStats(data)).toMatchObject({ cities: 0, visits: 0, countries: 0, countryVisits: 0, wishlist: 1 });
    const visited = createCity({ ...paris, osmRef: undefined, name: 'Другой город' });
    visited.visits.push(createVisit());
    expect(getStats(trackerReducer(data, { type: 'saveCity', city: visited }))).toMatchObject({ cities: 1, visits: 2, wishlist: 1 });
  });

  it('converts a plan once while keeping identity, context and all note text', () => {
    const plan = { ...createCity(paris, 'wishlist'), wishNote: 'Музей <не HTML>\nИ прогулка', regionName: 'Иль-де-Франс' };
    const visited = markCityVisited(plan);
    expect(visited).toMatchObject({ id: plan.id, coordinates: plan.coordinates, osmRefs: plan.osmRefs, countryCode: plan.countryCode, localityName: plan.localityName, regionName: plan.regionName, status: 'visited' });
    expect(visited.visits).toHaveLength(1);
    expect(visited.visits[0]).toMatchObject({ note: plan.wishNote, date: null });
    expect(visited.visits[0].id).toBeTruthy();
    expect(visited).not.toHaveProperty('wishNote');
    expect(plan.visits).toEqual([]);
    expect(plan.status).toBe('wishlist');
    expect(markCityVisited(visited)).toEqual(visited);
    const saved = trackerReducer({ ...createEmptyData(), cities: [plan] }, { type: 'saveCity', city: visited });
    expect(saved.cities).toHaveLength(1);
    expect(getStats(saved)).toMatchObject({ cities: 1, visits: 1, wishlist: 0, countries: 0 });
  });

  it('reads legacy visited places without adding status or plan-note fields', () => {
    const city = createCity(paris);
    city.visits.push({ ...createVisit(), date: '2025-06-17', note: 'Прежний визит' });
    const parsed = validateTrackerData({ ...createEmptyData(), cities: [city] }).cities[0];
    expect(parsed).toEqual(city);
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('wishNote');
    expect(markCityVisited(parsed)).toEqual(city);
    const explicit = { ...city, status: 'visited' as const };
    expect(validateTrackerData({ ...createEmptyData(), cities: [explicit] }).cities[0]).toEqual(explicit);
  });

  it('matches plans together with visited places instead of duplicating one OSM object', () => {
    const plan = createCity(paris, 'wishlist');
    expect(findCityMatch([plan], paris).exact?.id).toBe(plan.id);
    expect(findCityMatch([plan], { ...paris, osmRef: undefined }).suggestions).toEqual([plan]);
    const visited = createCity(paris);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [plan, visited] })).toThrow(/OSM/);
  });

  it.each([null, '', 'planned', 1, {}, []])('rejects invalid place status %s', status => {
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...createCity(paris), status }] })).toThrow(/статус/);
  });

  it('rejects visits on plans and plan notes on visited places rather than discarding information', () => {
    const plan = createCity(paris, 'wishlist');
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...plan, visits: [createVisit()] }] })).toThrow(/не должно быть визитов/);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...plan, visits: null }] })).toThrow(/список визитов/);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...createCity(paris), wishNote: 'Нельзя терять' }] })).toThrow(/Заметка плана/);
    for (const wishNote of [null, 123, {}, 'x'.repeat(1001)]) {
      expect(() => validateTrackerData({ ...createEmptyData(), cities: [{ ...plan, wishNote }] })).toThrow(/Заметка плана/);
    }
    expect(validateTrackerData({ ...createEmptyData(), cities: [{ ...plan, wishNote: 'x'.repeat(1000) }] }).cities[0].wishNote).toHaveLength(1000);
    const { wishNote: _unused, ...withoutNote } = plan;
    expect(validateTrackerData({ ...createEmptyData(), cities: [withoutNote] }).cities[0]).not.toHaveProperty('wishNote');
    expect(markCityVisited(withoutNote).visits[0].note).toBe('');
  });
});
