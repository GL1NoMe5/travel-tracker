import type {
  DataDrivenPropertyValueSpecification,
  LayerSpecification,
  PaddingOptions,
  ProjectionSpecification,
} from 'maplibre-gl';
import { isCountryCode } from '../data/countries';
import type { LngLat } from '../domain/types';
import { computePanelPadding, type PanelPaddingOptions } from './layout';

export const LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

export const COUNTRIES_SOURCE_ID = 'travel-countries';
export const COUNTRIES_HIT_LAYER_ID = 'travel-countries-hit';
export const COUNTRIES_FILL_LAYER_ID = 'travel-countries-fill';
export const COUNTRIES_OUTLINE_LAYER_ID = 'travel-countries-outline';
export const COUNTRIES_SELECTED_FILL_LAYER_ID = 'travel-countries-selected-fill';
export const COUNTRIES_SELECTED_OUTLINE_LAYER_ID = 'travel-countries-selected-outline';

export const INITIAL_GLOBE_CENTER: LngLat = [20, 20];
export const CITY_FOCUS_ZOOM = 10.5;
export const VISITED_COUNTRY_FILL_OPACITY = 0.45;
export const SELECTED_COUNTRY_FILL_OPACITY = 0.14;
export const SELECTED_COUNTRY_OUTLINE_OPACITY = 0.95;

export const GLOBE_TO_MERCATOR_PROJECTION: ProjectionSpecification = {
  type: ['interpolate', ['linear'], ['zoom'], 5, 'vertical-perspective', 6, 'mercator'],
};

export const RUSSIAN_NAME_EXPRESSION: DataDrivenPropertyValueSpecification<string> = [
  'coalesce',
  ['get', 'name:ru'],
  ['get', 'name'],
];

const TECHNICAL_LABEL_ID_PATTERN = /(?:shield|housenumber|one_way|ref)/i;
const TECHNICAL_SOURCE_LAYERS = new Set(['housenumber']);
const GEOGRAPHIC_NAME_TOKEN_PATTERN = /\bname(?::[a-z_-]+|_en|_de|_int)?\b/i;

function serializeExpression(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Identifies symbol layers that display geographic names (places, POIs, water, roads, airports)
 * while excluding road shields (`ref`), house numbers, and directional arrows.
 */
export function isGeographicNameLayer(
  layer: Pick<LayerSpecification, 'id' | 'type'> & {
    'source-layer'?: string;
    layout?: Record<string, unknown>;
  },
  currentTextField?: unknown,
): boolean {
  if (layer.type !== 'symbol') return false;
  if (TECHNICAL_LABEL_ID_PATTERN.test(layer.id)) return false;
  const sourceLayer = layer['source-layer'];
  if (sourceLayer && TECHNICAL_SOURCE_LAYERS.has(sourceLayer)) return false;

  const textField = currentTextField ?? layer.layout?.['text-field'];
  if (textField === undefined || textField === null) return false;

  const serialized = serializeExpression(textField);
  if (!serialized) return false;
  if (!GEOGRAPHIC_NAME_TOKEN_PATTERN.test(serialized)) return false;
  return true;
}

const ABOVE_COUNTRIES_SOURCE_LAYERS = new Set([
  'aeroway',
  'transportation',
  'building',
  'boundary',
  'transportation_name',
  'aerodrome_label',
  'poi',
  'place',
  'water_name',
  'housenumber',
]);

const ABOVE_COUNTRIES_ID_PATTERN =
  /^(?:aeroway|tunnel_|road_|bridge_|highway|building|boundary|poi|label_|airport)/i;

/**
 * Finds the first layer ID above the base surface (landcover/landuse/water)
 * and before aeroway, transportation, buildings, boundaries, and labels.
 */
export function findCountryLayerAnchor(
  layers: readonly (Pick<LayerSpecification, 'id' | 'type'> & { 'source-layer'?: string })[],
): string | undefined {
  for (const layer of layers) {
    const sourceLayer = layer['source-layer'];
    if (sourceLayer && ABOVE_COUNTRIES_SOURCE_LAYERS.has(sourceLayer)) {
      return layer.id;
    }
    if (ABOVE_COUNTRIES_ID_PATTERN.test(layer.id)) {
      return layer.id;
    }
    if (layer.type === 'symbol' || layer.type === 'fill-extrusion') {
      return layer.id;
    }
  }
  return undefined;
}

function getValidColoredEntries(
  countryColors: Readonly<Record<string, string>>,
): [string, string][] {
  return Object.entries(countryColors).filter(
    ([code, color]) => isCountryCode(code) && typeof color === 'string' && /^#[\da-f]{6}$/i.test(color),
  );
}

export function buildCountryFillColorExpression(
  countryColors: Readonly<Record<string, string>>,
): DataDrivenPropertyValueSpecification<string> {
  const entries = getValidColoredEntries(countryColors);
  if (entries.length === 0) {
    return 'rgba(0, 0, 0, 0)';
  }
  const matchArgs: unknown[] = ['match', ['get', 'iso2']];
  for (const [code, color] of entries) {
    matchArgs.push(code, color);
  }
  matchArgs.push('rgba(0, 0, 0, 0)');
  return matchArgs as unknown as DataDrivenPropertyValueSpecification<string>;
}

export function buildCountryFillOpacityExpression(
  countryColors: Readonly<Record<string, string>>,
): DataDrivenPropertyValueSpecification<number> {
  const codes = getValidColoredEntries(countryColors).map(([code]) => code);
  if (codes.length === 0) {
    return 0;
  }
  return [
    'match',
    ['get', 'iso2'],
    codes,
    VISITED_COUNTRY_FILL_OPACITY,
    0,
  ] as unknown as DataDrivenPropertyValueSpecification<number>;
}

export function buildCountryOutlineOpacityExpression(
  countryColors: Readonly<Record<string, string>>,
): DataDrivenPropertyValueSpecification<number> {
  const codes = getValidColoredEntries(countryColors).map(([code]) => code);
  if (codes.length === 0) {
    return 0;
  }
  return [
    'match',
    ['get', 'iso2'],
    codes,
    0.72,
    0,
  ] as unknown as DataDrivenPropertyValueSpecification<number>;
}

export function buildSelectedCountryOpacityExpression(
  selectedCountryCode: string | null,
  activeOpacity: number,
): DataDrivenPropertyValueSpecification<number> {
  if (!selectedCountryCode || !isCountryCode(selectedCountryCode)) {
    return 0;
  }
  return [
    'case',
    ['==', ['get', 'iso2'], selectedCountryCode],
    activeOpacity,
    0,
  ] as unknown as DataDrivenPropertyValueSpecification<number>;
}

export function computeViewportPadding(
  width: number,
  height: number,
  hasRightPanel: boolean | PanelPaddingOptions,
): Required<PaddingOptions> {
  return computePanelPadding(width, height, hasRightPanel);
}

/**
 * Computes an initial zoom level so the 3D globe fits comfortably inside the
 * unpadded available viewport on both desktop (1440x900) and mobile (390x844).
 */
export function computeInitialGlobeZoom(
  width: number,
  height: number,
  padding: Required<PaddingOptions>,
  latitude = INITIAL_GLOBE_CENTER[1],
): number {
  const availWidth = Math.max(120, width - padding.left - padding.right);
  const availHeight = Math.max(120, height - padding.top - padding.bottom);
  const targetRadiusPx = 0.42 * Math.min(availWidth, availHeight);
  // MapLibre default vertical FOV is ~36.87 deg, where tan(fov / 2) = 1 / 3 => cameraToCenterDistance = 1.5 * height
  const cameraDistance = 1.5 * Math.max(240, height);
  const ratio = targetRadiusPx / cameraDistance;
  const sphereRadiusPx = targetRadiusPx * (ratio + Math.sqrt(1 + ratio * ratio));
  const cosLat = Math.cos((Math.min(80, Math.abs(latitude)) * Math.PI) / 180);
  const rawZoom = Math.log2((sphereRadiusPx * 2 * Math.PI * cosLat) / 512);
  return Number(Math.max(-0.5, Math.min(3.5, rawZoom)).toFixed(2));
}

export function isValidLngLat(value: unknown): value is LngLat {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [lng, lat] = value;
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

export function normalizeLngLat(coordinates: LngLat): LngLat {
  const [rawLng, rawLat] = coordinates;
  let lng = ((((rawLng + 180) % 360) + 360) % 360) - 180;
  if (rawLng === 180) lng = 180;
  if (Object.is(lng, -0)) lng = 0;
  // Mercator camera limits must not move geographic points on the globe.
  return [Number(lng.toFixed(6)), Number(rawLat.toFixed(6))];
}

export interface SurfaceProjector {
  project(lngLat: LngLat): { x: number; y: number };
  unproject(point: [number, number]): { lng: number; lat: number };
  getZoom?: () => number;
}

/**
 * Verifies via public MapLibre project/unproject APIs that a screen point lies
 * on the visible surface of the globe/map (and not in empty space outside the sphere).
 */
export function resolveVisibleSurfacePoint(
  projector: SurfaceProjector,
  point: { x: number; y: number },
  containerSize: { width: number; height: number },
): LngLat | null {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x > containerSize.width ||
    point.y > containerSize.height
  ) {
    return null;
  }

  const unprojected = projector.unproject([point.x, point.y]);
  if (
    !unprojected ||
    !Number.isFinite(unprojected.lng) ||
    !Number.isFinite(unprojected.lat) ||
    Math.abs(unprojected.lat) > 90
  ) {
    return null;
  }

  const candidate: LngLat = [unprojected.lng, unprojected.lat];
  const reprojected = projector.project(candidate);
  if (!reprojected || !Number.isFinite(reprojected.x) || !Number.isFinite(reprojected.y)) {
    return null;
  }

  // Off-sphere clicks on the globe clamp to the horizon during unproject(),
  // so re-projecting them lands on the horizon rather than at `point`.
  const pixelError = Math.hypot(reprojected.x - point.x, reprojected.y - point.y);
  if (pixelError > 2) {
    return null;
  }

  const normalized = normalizeLngLat(candidate);
  return isValidLngLat(normalized) ? normalized : null;
}

/**
 * Determines via public project/unproject APIs whether a coordinate is occluded
 * on the back side of the 3D globe.
 */
export function isCoordinateOccludedOnGlobe(
  projector: SurfaceProjector,
  coordinates: LngLat,
): boolean {
  if (!isValidLngLat(coordinates)) return true;
  if (projector.getZoom && projector.getZoom() >= 6) {
    return false;
  }

  const screenPoint = projector.project(coordinates);
  if (!screenPoint || !Number.isFinite(screenPoint.x) || !Number.isFinite(screenPoint.y)) {
    return true;
  }

  const frontLngLat = projector.unproject([screenPoint.x, screenPoint.y]);
  if (!frontLngLat || !Number.isFinite(frontLngLat.lng) || !Number.isFinite(frontLngLat.lat)) {
    return true;
  }

  const reprojected = projector.project([frontLngLat.lng, frontLngLat.lat]);
  if (
    !reprojected ||
    !Number.isFinite(reprojected.x) ||
    !Number.isFinite(reprojected.y) ||
    Math.hypot(reprojected.x - screenPoint.x, reprojected.y - screenPoint.y) > 2.5
  ) {
    return true;
  }

  const toRad = Math.PI / 180;
  const lat1 = coordinates[1] * toRad;
  const lat2 = frontLngLat.lat * toRad;
  const dLng = (coordinates[0] - frontLngLat.lng) * toRad;
  const cosAngle =
    Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return cosAngle < 0.9995;
}

export function extractCountryCodeFromFeatures(
  features: readonly { id?: string | number; properties?: Record<string, unknown> | null }[],
): string | null {
  for (const feature of features) {
    const iso2 = feature.properties?.iso2;
    if (typeof iso2 === 'string' && isCountryCode(iso2)) {
      return iso2;
    }
    if (typeof feature.id === 'string' && isCountryCode(feature.id)) {
      return feature.id;
    }
  }
  return null;
}

export function classifyMapError(
  event: { error?: unknown; sourceId?: string; tile?: unknown },
  styleLoaded: boolean,
): { fatal: boolean; message?: string } {
  // Single tile load failures are transient and must not crash the map.
  if (event.tile !== undefined && event.tile !== null) {
    return { fatal: false };
  }

  const rawMessage =
    event.error instanceof Error
      ? event.error.message
      : typeof event.error === 'string'
        ? event.error
        : '';

  if (
    event.sourceId === COUNTRIES_SOURCE_ID ||
    rawMessage.toLowerCase().includes('countries.geojson')
  ) {
    return {
      fatal: true,
      message: 'Не удалось загрузить границы стран. Проверьте подключение и попробуйте снова.',
    };
  }

  if (/webgl|gpu|context/i.test(rawMessage)) {
    return {
      fatal: true,
      message: 'Не удалось инициализировать WebGL2 для отображения 3D-карты.',
    };
  }

  if (event.sourceId) {
    return {
      fatal: true,
      message: 'Не удалось загрузить данные подложки карты. Проверьте подключение и попробуйте снова.',
    };
  }

  if (!styleLoaded && !event.sourceId) {
    return {
      fatal: true,
      message: 'Не удалось загрузить стиль карты. Проверьте подключение к сети и попробуйте снова.',
    };
  }

  return { fatal: false };
}
