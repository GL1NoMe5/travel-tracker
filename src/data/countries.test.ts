import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COUNTRIES, COUNTRY_BY_CODE, isCountryCode, TOTAL_COUNTRIES } from './countries';

type Point = [number, number];
interface CountryFeature {
  id: string;
  properties: { iso2: string };
  geometry: { type: string; coordinates: Point[][][] };
}
const bytes = readFileSync(new URL('../../public/data/countries.geojson', import.meta.url));
const collection = JSON.parse(bytes.toString()) as { type: string; features: CountryFeature[] };
const manifest = JSON.parse(readFileSync(new URL('../../public/data/countries.manifest.json', import.meta.url), 'utf8'));

function contains(point: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = point, [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('country data integrity', () => {
  it('has exactly the 195 unique catalog countries, including both observers', () => {
    expect(TOTAL_COUNTRIES).toBe(195);
    expect(COUNTRIES).toHaveLength(195);
    expect(COUNTRY_BY_CODE.size).toBe(195);
    expect(COUNTRY_BY_CODE.has('VA')).toBe(true);
    expect(COUNTRY_BY_CODE.has('PS')).toBe(true);
    for (const excluded of ['AQ', 'GL', 'TW', 'XK', '-99', 'fr', '__proto__']) expect(isCountryCode(excluded)).toBe(false);
    expect(COUNTRY_BY_CODE.get('FR')?.name).toBe('Франция');
    expect(COUNTRY_BY_CODE.get('NO')?.name).toBe('Норвегия');
  });

  it('provides a selectable multipart feature for every catalog country', () => {
    expect(collection.type).toBe('FeatureCollection');
    expect(collection.features).toHaveLength(195);
    expect(new Set(collection.features.map((feature) => feature.id))).toEqual(new Set(COUNTRIES.map((country) => country.code)));
    for (const feature of collection.features) {
      expect(feature.id).toBe(feature.properties.iso2);
      expect(feature.geometry.type).toBe('MultiPolygon');
      expect(feature.geometry.coordinates.length).toBeGreaterThan(0);
    }
    for (const code of ['VA', 'MC', 'SM', 'NR', 'TV', 'LI', 'MT', 'PS']) {
      const feature = collection.features.find((item) => item.id === code)!;
      expect(feature.geometry.coordinates[0][0].length).toBeGreaterThan(3);
    }
  });

  it('retains closed rings, finite coordinates and antimeridian cuts', () => {
    const errors: string[] = [];
    for (const feature of collection.features) for (const polygon of feature.geometry.coordinates) for (const ring of polygon) {
      if (ring.length < 4 || ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]) errors.push(`${feature.id}: open ring`);
      for (let i = 0; i < ring.length; i++) {
        const [longitude, latitude] = ring[i];
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) errors.push(`${feature.id}: invalid coordinate`);
        if (i && Math.abs(longitude - ring[i - 1][0]) > 180) errors.push(`${feature.id}: antimeridian jump`);
      }
    }
    expect(errors).toEqual([]);
    expect(collection.features.find((feature) => feature.id === 'FJ')!.geometry.coordinates.length).toBeGreaterThan(1);
    expect(collection.features.find((feature) => feature.id === 'RU')!.geometry.coordinates.length).toBeGreaterThan(1);
  });

  it('uses representative points on land instead of global bounding-box centers', () => {
    const errors: string[] = [];
    for (const country of COUNTRIES) {
      const feature = collection.features.find((item) => item.id === country.code)!;
      const onLand = feature.geometry.coordinates.some((polygon) =>
        contains(country.center, polygon[0]) && !polygon.slice(1).some((hole) => contains(country.center, hole)),
      );
      if (!onLand) errors.push(country.code);
      expect(country.zoom).toBeGreaterThanOrEqual(1.25);
      expect(country.zoom).toBeLessThanOrEqual(13);
    }
    expect(errors).toEqual([]);
    expect(Math.abs(COUNTRY_BY_CODE.get('FJ')!.center[0])).toBeGreaterThan(170);
    expect(COUNTRY_BY_CODE.get('FR')!.center[0]).toBeGreaterThan(-5);
    expect(COUNTRY_BY_CODE.get('FR')!.center[0]).toBeLessThan(10);
  });

  it('matches the pinned provenance manifest', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.geojsonSha256);
    expect(bytes.length).toBe(manifest.bytes);
    expect(manifest.featureCount).toBe(195);
    expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
  });
});
