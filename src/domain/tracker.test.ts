import { describe, expect, it } from 'vitest';
import { createCity, createEmptyData, createVisit, findCityMatch, getStats, isCalendarDate, trackerReducer, validateTrackerData } from './tracker';
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
});
