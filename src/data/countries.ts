import type { Country, LngLat } from '../domain/types';
import codes from './country-codes.json';
import geography from './country-geography.json';

const regionNames = new Intl.DisplayNames(['ru'], { type: 'region' });
const codeSet = new Set(codes);

/** 193 UN member states plus Holy See (VA) and Palestine (PS). */
export const COUNTRIES: Country[] = geography.map(({ code, center, zoom }) => ({
  code,
  name: regionNames.of(code) ?? code,
  center: center as LngLat,
  zoom,
})).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

export const COUNTRY_BY_CODE: ReadonlyMap<string, Country> = new Map(
  COUNTRIES.map((country) => [country.code, country]),
);

/** State and backup files use uppercase ISO alpha-2, without coercion. */
export function isCountryCode(value: string): boolean {
  return codeSet.has(value);
}

export const COUNTRIES_GEOJSON_URL = '/data/countries.geojson';
export const TOTAL_COUNTRIES = codes.length;
