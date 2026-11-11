import { isCountryCode } from '../data/countries';
import type { City, PlaceCandidate, PlaceStatus, TrackerData, Visit } from './types';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_NAME_LENGTH = 120;
export const MAX_COUNTRY_VISITS = 999;
export const DEFAULT_COUNTRY_COLOR = '#C45B3D';
export const COLOR_PRESETS = ['#46A88C', '#68A8D5', '#8885CB', '#D788AB', '#E5A564', '#D6BC62', '#85B66E', '#CC7773'] as const;

export class DataValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'DataValidationError'; }
}

function fail(message: string): never { throw new DataValidationError(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: ожидается объект.`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${label}: неверное текстовое значение.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail(`${label}: неверный идентификатор.`);
  return result;
}
function optionalString(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : string(value, label, max);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Validate the entire snapshot before returning a detached, canonical copy. */
export function validateTrackerData(input: unknown): TrackerData {
  const root = record(input, 'Файл');
  if (root.schemaVersion !== 1) fail('Неподдерживаемая версия данных. Требуется schemaVersion: 1.');
  const rawColors = record(root.countryColors, 'Цвета стран');
  const countryColors: Record<string, string> = {};
  for (const [code, color] of Object.entries(rawColors)) {
    if (!isCountryCode(code)) fail(`Неизвестная страна: ${code}.`);
    if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) fail(`Неверный цвет страны ${code}.`);
    countryColors[code] = color.toUpperCase();
  }
  const rawCountryVisits = root.countryVisits === undefined ? {} : record(root.countryVisits, 'Посещения стран');
  const countryVisits: Record<string, number> = {};
  for (const [code, count] of Object.entries(rawCountryVisits)) {
    if (!isCountryCode(code)) fail(`Неизвестная страна: ${code}.`);
    if (!Object.hasOwn(countryColors, code)) fail(`Посещения указаны для неотмеченной страны ${code}.`);
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_COUNTRY_VISITS) {
      fail(`Количество посещений страны ${code} должно быть целым числом от 1 до ${MAX_COUNTRY_VISITS}.`);
    }
    countryVisits[code] = count;
  }
  // Older v1 snapshots recorded only the presence of a country, not trip counts.
  for (const code of Object.keys(countryColors)) countryVisits[code] ??= 1;
  if (!Array.isArray(root.cities) || root.cities.length > 5000) fail('Ожидается список, содержащий не более 5000 городов.');
  const cityIds = new Set<string>();
  const visitIds = new Set<string>();
  const osmRefs = new Set<string>();
  const cities = root.cities.map((item, index): City => {
    const raw = record(item, `Город ${index + 1}`);
    const cityId = id(raw.id, 'ID города');
    if (cityIds.has(cityId)) fail('Обнаружены повторяющиеся ID городов.');
    cityIds.add(cityId);
    const name = string(raw.name, 'Название города', MAX_NAME_LENGTH).trim();
    const coords = raw.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(v => typeof v === 'number' && Number.isFinite(v)) || Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) fail(`Неверные координаты города ${name}.`);
    const countryCode = optionalString(raw.countryCode, 'Код страны', 2);
    if (countryCode !== undefined && !/^[A-Z]{2}$/.test(countryCode)) fail('Код страны города должен состоять из двух заглавных букв.');
    if (!Array.isArray(raw.osmRefs) || raw.osmRefs.length > 100) fail('Неверный список OSM-идентификаторов.');
    const refs = raw.osmRefs.map((ref): string => {
      if (typeof ref !== 'string' || !/^(node|way|relation):[1-9]\d*$/.test(ref)) fail('Неверный OSM-идентификатор.');
      if (osmRefs.has(ref)) fail('Один OSM-объект указан несколько раз.');
      osmRefs.add(ref);
      return ref;
    });
    const status = raw.status;
    if (status !== undefined && status !== 'visited' && status !== 'wishlist') fail(`Неверный статус места ${name}.`);
    let wishNote: string | undefined;
    if (raw.wishNote !== undefined) {
      if (status !== 'wishlist') fail('Заметка плана допустима только для места «Хочу посетить».');
      wishNote = string(raw.wishNote, 'Заметка плана', MAX_NOTE_LENGTH, true);
    }
    if (!Array.isArray(raw.visits)) fail(`Неверный список визитов места ${name}.`);
    if (status === 'wishlist' ? raw.visits.length !== 0 : raw.visits.length === 0 || raw.visits.length > 500) {
      fail(status === 'wishlist' ? `У запланированного места ${name} не должно быть визитов.` : `У города ${name} должно быть от 1 до 500 визитов.`);
    }
    const visits = raw.visits.map((item): Visit => {
      const visit = record(item, 'Визит');
      const visitId = id(visit.id, 'ID визита');
      if (visitIds.has(visitId)) fail('Обнаружены повторяющиеся ID визитов.');
      visitIds.add(visitId);
      if (visit.date !== null && (typeof visit.date !== 'string' || !isCalendarDate(visit.date))) fail('Неверная дата визита. Используйте ГГГГ-ММ-ДД или null.');
      return { id: visitId, date: visit.date, note: string(visit.note, 'Заметка', MAX_NOTE_LENGTH, true) };
    });
    return {
      id: cityId, name, coordinates: [coords[0], coords[1]], countryCode,
      localityName: optionalString(raw.localityName, 'Исходное название', 300),
      regionName: optionalString(raw.regionName, 'Регион', 500),
      osmRefs: refs, visits,
      ...(status === undefined ? {} : { status }),
      ...(wishNote === undefined ? {} : { wishNote }),
    };
  });
  return { schemaVersion: 1, countryColors, countryVisits, cities };
}

export const createEmptyData = (): TrackerData => ({ schemaVersion: 1, countryColors: {}, countryVisits: {}, cities: [] });
export const createVisit = (): Visit => ({ id: crypto.randomUUID(), date: null, note: '' });
export function createCity(candidate: PlaceCandidate, status: PlaceStatus = 'visited'): City {
  return {
    id: crypto.randomUUID(), name: candidate.name, coordinates: [...candidate.coordinates],
    countryCode: candidate.countryCode, localityName: candidate.localityName, regionName: candidate.regionName,
    osmRefs: candidate.osmRef ? [candidate.osmRef] : [],
    visits: status === 'wishlist' ? [] : [createVisit()],
    ...(status === 'wishlist' ? { status, wishNote: '' } : {}),
  };
}

/** Fulfil a plan without creating a second place or losing its note. */
export function markCityVisited(city: City): City {
  if (city.status !== 'wishlist') return city;
  const { wishNote, ...place } = city;
  return { ...place, status: 'visited', visits: [{ ...createVisit(), note: wishNote ?? '' }] };
}

export type TrackerAction =
  | { type: 'colorCountry'; code: string; color: string }
  | { type: 'setCountryVisits'; code: string; count: number }
  | { type: 'resetCountry'; code: string }
  | { type: 'saveCity'; city: City }
  | { type: 'deleteCity'; id: string }
  | { type: 'replace'; data: TrackerData };

export function trackerReducer(state: TrackerData, action: TrackerAction): TrackerData {
  switch (action.type) {
    case 'colorCountry': return validateTrackerData({ ...state, countryColors: { ...state.countryColors, [action.code]: action.color } });
    case 'setCountryVisits': return validateTrackerData({
      ...state,
      countryColors: { ...state.countryColors, [action.code]: state.countryColors[action.code] ?? DEFAULT_COUNTRY_COLOR },
      countryVisits: { ...state.countryVisits, [action.code]: action.count },
    });
    case 'resetCountry': {
      const colors = { ...state.countryColors }; delete colors[action.code];
      const countryVisits = { ...state.countryVisits }; delete countryVisits[action.code];
      return validateTrackerData({ ...state, countryColors: colors, countryVisits });
    }
    case 'saveCity': return validateTrackerData({ ...state, cities: state.cities.some(c => c.id === action.city.id) ? state.cities.map(c => c.id === action.city.id ? action.city : c) : [...state.cities, action.city] });
    case 'deleteCity': return { ...state, cities: state.cities.filter(c => c.id !== action.id) };
    case 'replace': return validateTrackerData(action.data);
  }
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
}
export function findCityMatch(cities: readonly City[], candidate: PlaceCandidate): { exact: City | undefined; suggestions: City[] } {
  const exact = candidate.osmRef ? cities.find(c => c.osmRefs.includes(candidate.osmRef!)) : undefined;
  if (exact) return { exact, suggestions: [] };
  const name = normalizeName(candidate.localityName || candidate.name);
  return { exact: undefined, suggestions: cities.filter(city => {
    if (city.countryCode && candidate.countryCode && city.countryCode !== candidate.countryCode) return false;
    return normalizeName(city.localityName || city.name) === name;
  }) };
}

export function getCountryVisitCount(data: TrackerData, code: string): number {
  return isCountryCode(code) && Object.hasOwn(data.countryColors, code) ? data.countryVisits?.[code] ?? 1 : 0;
}

export function getStats(data: TrackerData) {
  const countries = Object.keys(data.countryColors).filter(isCountryCode).length;
  const countryVisits = Object.keys(data.countryColors).filter(isCountryCode).reduce((sum, code) => sum + getCountryVisitCount(data, code), 0);
  const visited = data.cities.filter(city => city.status !== 'wishlist');
  return { countries, totalCountries: 195, percent: countries / 195 * 100, countryVisits, cities: visited.length, visits: visited.reduce((sum, city) => sum + city.visits.length, 0), wishlist: data.cities.length - visited.length };
}

export function latestVisitDate(city: City): string | null {
  return city.visits.flatMap(visit => visit.date ? [visit.date] : []).sort().at(-1) ?? null;
}

export function formatCalendarDate(value: string | null): string {
  return value ? value.split('-').reverse().join('.') : 'Без даты';
}
