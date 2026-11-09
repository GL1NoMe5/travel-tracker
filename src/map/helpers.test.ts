import { describe, expect, it } from 'vitest';
import {
  COUNTRIES_SOURCE_ID,
  GLOBE_TO_MERCATOR_PROJECTION,
  RUSSIAN_NAME_EXPRESSION,
  SELECTED_COUNTRY_FILL_OPACITY,
  VISITED_COUNTRY_FILL_OPACITY,
  buildCountryFillColorExpression,
  buildCountryFillOpacityExpression,
  buildCountryOutlineOpacityExpression,
  buildSelectedCountryOpacityExpression,
  classifyMapError,
  computeInitialGlobeZoom,
  computeViewportPadding,
  extractCountryCodeFromFeatures,
  findCountryLayerAnchor,
  isCoordinateOccludedOnGlobe,
  isGeographicNameLayer,
  isValidLngLat,
  normalizeLngLat,
  resolveVisibleSurfacePoint,
  type SurfaceProjector,
} from './helpers';

describe('map helpers', () => {
  it('defines smooth interpolation from vertical-perspective (<=5) to mercator (>=6)', () => {
    expect(GLOBE_TO_MERCATOR_PROJECTION).toEqual({
      type: ['interpolate', ['linear'], ['zoom'], 5, 'vertical-perspective', 6, 'mercator'],
    });
  });

  it('identifies geographic symbol layers for Russian labels and skips technical layers', () => {
    expect(
      isGeographicNameLayer({
        id: 'label_country_1',
        type: 'symbol',
        'source-layer': 'place',
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
        },
      }),
    ).toBe(true);

    expect(
      isGeographicNameLayer({
        id: 'poi_r1',
        type: 'symbol',
        'source-layer': 'poi',
        layout: {
          'text-field': '{name}',
        },
      }),
    ).toBe(true);

    // Idempotent when already patched with RUSSIAN_NAME_EXPRESSION
    expect(
      isGeographicNameLayer(
        {
          id: 'label_city',
          type: 'symbol',
          'source-layer': 'place',
        },
        RUSSIAN_NAME_EXPRESSION,
      ),
    ).toBe(true);

    // Technical symbol layers must not be modified
    expect(
      isGeographicNameLayer({
        id: 'highway-shield-non-us',
        type: 'symbol',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': '{ref}',
        },
      }),
    ).toBe(false);

    expect(
      isGeographicNameLayer({
        id: 'road_one_way_arrow',
        type: 'symbol',
        'source-layer': 'transportation',
      }),
    ).toBe(false);

    expect(
      isGeographicNameLayer({
        id: 'housenumber',
        type: 'symbol',
        'source-layer': 'housenumber',
        layout: {
          'text-field': '{housenumber}',
        },
      }),
    ).toBe(false);
  });

  it('selects the first layer above base land/water as the country layer anchor', () => {
    const libertyExcerpt = [
      { id: 'background', type: 'background' as const },
      { id: 'natural_earth', type: 'raster' as const },
      { id: 'park', type: 'fill' as const, 'source-layer': 'park' },
      { id: 'landuse_residential', type: 'fill' as const, 'source-layer': 'landuse' },
      { id: 'water', type: 'fill' as const, 'source-layer': 'water' },
      { id: 'landcover_sand', type: 'fill' as const, 'source-layer': 'landcover' },
      { id: 'aeroway_fill', type: 'fill' as const, 'source-layer': 'aeroway' },
      { id: 'tunnel_motorway_casing', type: 'line' as const, 'source-layer': 'transportation' },
      { id: 'building-3d', type: 'fill-extrusion' as const, 'source-layer': 'building' },
      { id: 'boundary_2', type: 'line' as const, 'source-layer': 'boundary' },
      { id: 'label_country_1', type: 'symbol' as const, 'source-layer': 'place' },
    ];

    expect(findCountryLayerAnchor(libertyExcerpt)).toBe('aeroway_fill');
  });

  it('builds country fill and selection expressions safely', () => {
    expect(buildCountryFillColorExpression({})).toBe('rgba(0, 0, 0, 0)');
    expect(buildCountryFillOpacityExpression({})).toBe(0);
    expect(buildCountryOutlineOpacityExpression({})).toBe(0);

    const colors = {
      FR: '#14b8a6',
      JP: '#f59e0b',
      INVALID: '#123456',
      DE: 'not-a-color',
    };

    expect(buildCountryFillColorExpression(colors)).toEqual([
      'match',
      ['get', 'iso2'],
      'FR',
      '#14b8a6',
      'JP',
      '#f59e0b',
      'rgba(0, 0, 0, 0)',
    ]);

    expect(buildCountryFillOpacityExpression(colors)).toEqual([
      'match',
      ['get', 'iso2'],
      ['FR', 'JP'],
      VISITED_COUNTRY_FILL_OPACITY,
      0,
    ]);

    expect(
      buildSelectedCountryOpacityExpression('FR', SELECTED_COUNTRY_FILL_OPACITY),
    ).toEqual(['case', ['==', ['get', 'iso2'], 'FR'], SELECTED_COUNTRY_FILL_OPACITY, 0]);
    expect(buildSelectedCountryOpacityExpression(null, SELECTED_COUNTRY_FILL_OPACITY)).toBe(0);
    expect(buildSelectedCountryOpacityExpression('ZZ', SELECTED_COUNTRY_FILL_OPACITY)).toBe(0);
  });

  it('computes initial globe zoom < 5 on both desktop (1440x900) and mobile (390x844)', () => {
    const desktopPadding = computeViewportPadding(1440, 900, false);
    const desktopZoom = computeInitialGlobeZoom(1440, 900, desktopPadding);
    expect(desktopZoom).toBeGreaterThan(0.5);
    expect(desktopZoom).toBeLessThan(4.5);

    const mobilePadding = computeViewportPadding(390, 844, false);
    const mobileZoom = computeInitialGlobeZoom(390, 844, mobilePadding);
    expect(mobileZoom).toBeGreaterThan(0);
    expect(mobileZoom).toBeLessThan(4.5);
  });

  it('validates and normalizes coordinates', () => {
    expect(isValidLngLat([37.6176, 55.7558])).toBe(true);
    expect(isValidLngLat([190, 55])).toBe(false);
    expect(isValidLngLat([37, -95])).toBe(false);
    expect(normalizeLngLat([185, 55.1234567])).toEqual([-175, 55.123457]);
  });

  it.each([-90, -89, 89, 90])('preserves polar latitude %s when wrapping longitude', (latitude) => {
    const coordinates = normalizeLngLat([185, latitude]);
    expect(coordinates).toEqual([-175, latitude]);
    expect(isValidLngLat(coordinates)).toBe(true);
  });

  it('distinguishes visible globe surface clicks from off-sphere clicks', () => {
    // Simulated globe centered at (500, 400) with radius 200px
    const globeProjector: SurfaceProjector = {
      getZoom: () => 2,
      project([lng, lat]) {
        return {
          x: 500 + lng * 2,
          y: 400 - lat * 2,
        };
      },
      unproject([x, y]) {
        const dx = x - 500;
        const dy = 400 - y;
        const dist = Math.hypot(dx, dy);
        // Clamp to horizon radius 200px when clicking outside the sphere
        const scale = dist > 200 ? 200 / dist : 1;
        return {
          lng: (dx * scale) / 2,
          lat: (dy * scale) / 2,
        };
      },
    };

    const onSphere = resolveVisibleSurfacePoint(
      globeProjector,
      { x: 540, y: 360 },
      { width: 1000, height: 800 },
    );
    expect(onSphere).toEqual([20, 20]);

    // Visible points near the poles must not move to the Mercator latitude limit.
    expect(resolveVisibleSurfacePoint(
      globeProjector,
      { x: 500, y: 222 },
      { width: 1000, height: 800 },
    )).toEqual([0, 89]);
    expect(resolveVisibleSurfacePoint(
      globeProjector,
      { x: 500, y: 578 },
      { width: 1000, height: 800 },
    )).toEqual([0, -89]);

    const offSphere = resolveVisibleSurfacePoint(
      globeProjector,
      { x: 100, y: 100 },
      { width: 1000, height: 800 },
    );
    expect(offSphere).toBeNull();
  });

  it('detects whether a marker coordinate is on the back side of the 3D globe', () => {
    // Orthographic hemisphere centered at [0, 0]
    const globeProjector: SurfaceProjector = {
      getZoom: () => 2,
      project([lng, lat]) {
        const radLng = (lng * Math.PI) / 180;
        const radLat = (lat * Math.PI) / 180;
        return {
          x: 500 + 200 * Math.cos(radLat) * Math.sin(radLng),
          y: 400 - 200 * Math.sin(radLat),
        };
      },
      unproject([x, y]) {
        const nx = Math.max(-1, Math.min(1, (x - 500) / 200));
        const ny = Math.max(-1, Math.min(1, (400 - y) / 200));
        const lat = Math.asin(ny);
        const cosLat = Math.max(1e-6, Math.cos(lat));
        const sinLng = Math.max(-1, Math.min(1, nx / cosLat));
        const lng = Math.asin(sinLng);
        return {
          lng: (lng * 180) / Math.PI,
          lat: (lat * 180) / Math.PI,
        };
      },
    };

    // Front of globe: [15, 20] -> visible
    expect(isCoordinateOccludedOnGlobe(globeProjector, [15, 20])).toBe(false);
    // Back of globe: [165, 20] -> occluded
    expect(isCoordinateOccludedOnGlobe(globeProjector, [165, 20])).toBe(true);
  });

  it('extracts valid ISO2 country codes from rendered features', () => {
    expect(
      extractCountryCodeFromFeatures([
        { id: 'FR', properties: { iso2: 'FR' } },
      ]),
    ).toBe('FR');
    expect(
      extractCountryCodeFromFeatures([
        { id: 'UNKNOWN', properties: { iso2: 'UNKNOWN' } },
      ]),
    ).toBeNull();
  });

  it('classifies fatal map errors vs transient tile errors', () => {
    expect(
      classifyMapError({ error: new Error('tile 404'), sourceId: 'openmaptiles', tile: { tileID: 1 } }, true),
    ).toEqual({ fatal: false });

    expect(
      classifyMapError({ error: new Error('404'), sourceId: COUNTRIES_SOURCE_ID }, true),
    ).toEqual({
      fatal: true,
      message: 'Не удалось загрузить границы стран. Проверьте подключение и попробуйте снова.',
    });

    expect(
      classifyMapError({ error: new Error('Failed to initialize WebGL2 context') }, false),
    ).toEqual({
      fatal: true,
      message: 'Не удалось инициализировать WebGL2 для отображения 3D-карты.',
    });

    expect(
      classifyMapError({ error: new Error('Style fetch failed') }, false),
    ).toEqual({
      fatal: true,
      message: 'Не удалось загрузить стиль карты. Проверьте подключение к сети и попробуйте снова.',
    });
  });

  it.each([false, true])('treats basemap metadata failure as fatal with styleLoaded=%s', (styleLoaded) => {
    expect(classifyMapError({
      error: new Error('TileJSON request failed: 503'),
      sourceId: 'openmaptiles',
    }, styleLoaded)).toEqual({
      fatal: true,
      message: 'Не удалось загрузить данные подложки карты. Проверьте подключение и попробуйте снова.',
    });
  });
});
