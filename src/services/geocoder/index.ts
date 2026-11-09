import type { LngLat, PlaceCandidate } from '../../domain/types';

const INTERVAL_MS = 1100;
const TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 150;
const CACHE_KEY = 'travel-tracker:geocoder-cache:v1';
const RATE_KEY = 'travel-tracker:geocoder-rate:v1';
const LOCK_KEY = 'travel-tracker:geocoder-request:v1';

export type GeocoderErrorCode = 'invalid-input' | 'configuration' | 'unsupported'
  | 'network' | 'timeout' | 'rate-limit' | 'no-result' | 'invalid-response';

export class GeocoderError extends Error {
  constructor(public readonly code: GeocoderErrorCode, message: string, public readonly retryAt?: number) {
    super(message);
    this.name = 'GeocoderError';
  }
}

export interface GeocoderClient {
  searchCities(query: string, signal?: AbortSignal): Promise<PlaceCandidate[]>;
  reverseGeocode(coordinates: LngLat, signal?: AbortSignal): Promise<PlaceCandidate>;
}

export interface GeocoderLockManager {
  request<T>(name: string, options: { mode: 'exclusive'; signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

export interface GeocoderOptions {
  fetch?: typeof globalThis.fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  locks?: GeocoderLockManager | null;
  /** Test seam or an alternate same-origin deployment path. */
  configUrl?: string;
}

interface RateState { lastDispatch: number; blockedUntil: number }
interface CacheEntry { key: string; expires: number; data: PlaceCandidate[] }

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Запрос отменён.', 'AbortError');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Запрос отменён.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max).trimEnd() : undefined;
}

function coordinate(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    return Number(value);
  }
  return NaN;
}

function validCoordinates(value: unknown): value is LngLat {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}

const SETTLEMENT_TYPES = new Set(['city', 'town', 'village', 'hamlet', 'municipality', 'isolated_dwelling']);

function parsePlace(value: unknown): PlaceCandidate | null {
  const item = record(value);
  const address = record(item.address);
  const names = record(item.namedetails);
  const coordinates: LngLat = [coordinate(item.lon), coordinate(item.lat)];
  if (!validCoordinates(coordinates)) return null;
  const ownSettlement = SETTLEMENT_TYPES.has(String(item.addresstype)) || SETTLEMENT_TYPES.has(String(item.type));
  const locality = text(address.city, 300) ?? text(address.town, 300) ?? text(address.village, 300)
    ?? text(address.municipality, 300) ?? text(address.hamlet, 300) ?? (ownSettlement ? text(item.name, 300) : undefined);
  if (!locality) return null;
  // namedetails belongs to the returned object, which can be an administrative area.
  const name = (ownSettlement ? text(names['name:ru'], 120) : undefined) ?? text(locality, 120)!;
  const countryCode = /^[a-z]{2}$/i.test(String(address.country_code))
    ? String(address.country_code).toUpperCase() : undefined;
  const osmType = text(item.osm_type);
  const osmId = typeof item.osm_id === 'string' || (typeof item.osm_id === 'number' && Number.isSafeInteger(item.osm_id))
    ? String(item.osm_id) : '';
  const osmRef = osmType && /^(node|way|relation)$/.test(osmType) && /^[1-9]\d*$/.test(osmId)
    ? `${osmType}:${osmId}` : undefined;
  const regionName = text([text(address.state), text(address.county)].filter(Boolean).join(', '), 500);
  return {
    name, coordinates, countryCode, localityName: locality, regionName, osmRef,
    displayName: text(item.display_name) ?? name,
  };
}

function isCachedPlace(value: unknown): value is PlaceCandidate {
  const place = record(value);
  const optionalText = (item: unknown, max: number) => item === undefined
    || (typeof item === 'string' && !!item.trim() && item.length <= max);
  return typeof place.name === 'string' && !!place.name.trim() && place.name.length <= 120
    && typeof place.displayName === 'string' && !!place.displayName.trim() && place.displayName.length <= 500
    && validCoordinates(place.coordinates)
    && optionalText(place.localityName, 300) && optionalText(place.regionName, 500)
    && (place.countryCode === undefined || (typeof place.countryCode === 'string' && /^[A-Z]{2}$/.test(place.countryCode)))
    && (place.osmRef === undefined || (typeof place.osmRef === 'string' && /^(node|way|relation):[1-9]\d*$/.test(place.osmRef)));
}

function browserStorage(): GeocoderOptions['storage'] {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function browserLocks(): GeocoderLockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

function retryDeadline(header: string | null): number {
  const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) : NaN;
  const deadline = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(header ?? '');
  return Math.max(Date.now() + INTERVAL_MS, Number.isFinite(deadline) ? deadline : Date.now() + 60_000);
}

/** No network activity occurs until the caller explicitly submits a search or map point. */
export function createGeocoder(options: GeocoderOptions = {}): GeocoderClient {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const locks = options.locks === undefined ? browserLocks() : options.locks;
  const configUrl = options.configUrl ?? `${import.meta.env.BASE_URL}config.json`;
  let configPromise: Promise<string> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let rate: RateState = { lastDispatch: -Infinity, blockedUntil: 0 };
  let cache: CacheEntry[] = [];

  function refreshCache(): void {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(CACHE_KEY) ?? '[]');
      if (Array.isArray(raw)) {
        const stored = raw.filter((entry): entry is CacheEntry => {
          const item = record(entry);
          return typeof item.key === 'string' && item.key.length < 3000
            && typeof item.expires === 'number' && item.expires > Date.now()
            && Array.isArray(item.data) && item.data.length <= 10 && item.data.every(isCachedPlace);
        });
        const merged = new Map(cache.filter(item => item.expires > Date.now()).map(item => [item.key, item]));
        for (const item of stored) {
          if ((merged.get(item.key)?.expires ?? 0) < item.expires) merged.set(item.key, item);
        }
        cache = [...merged.values()].slice(-CACHE_LIMIT);
      }
    } catch { /* A damaged cache is disposable; travel data is in a separate key. */ }
  }

  function readRate(): boolean {
    try {
      if (!storage) return false;
      const stored = record(JSON.parse(storage.getItem(RATE_KEY) ?? '{}'));
      if (typeof stored.lastDispatch === 'number' && Number.isFinite(stored.lastDispatch)) {
        rate.lastDispatch = Math.max(rate.lastDispatch, stored.lastDispatch);
      }
      if (typeof stored.blockedUntil === 'number' && Number.isFinite(stored.blockedUntil)) {
        rate.blockedUntil = Math.max(rate.blockedUntil, stored.blockedUntil);
      }
      return true;
    } catch { return false; }
  }

  function writeRate(): void {
    try { storage?.setItem(RATE_KEY, JSON.stringify(rate)); } catch { /* Lock still guards the dispatch interval. */ }
  }

  function checkCooldown(): void {
    if (rate.blockedUntil > Date.now()) {
      throw new GeocoderError('rate-limit', 'Сервис поиска просит подождать. Попробуйте позже или введите название вручную.', rate.blockedUntil);
    }
  }

  async function fetchJson(url: string, signal?: AbortSignal, provider = false): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    try {
      abortIfNeeded(signal);
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'strict-origin-when-cross-origin',
        ...(provider ? {} : { cache: 'no-store' as RequestCache }),
      });
      if (provider && response.status === 429) {
        rate.blockedUntil = retryDeadline(response.headers.get('Retry-After'));
        writeRate();
        checkCooldown();
      }
      if (!response.ok) {
        if (provider && response.status === 404) throw new GeocoderError('no-result', 'Населённый пункт не найден. Можно ввести название вручную.');
        throw new GeocoderError(provider ? 'network' : 'configuration', provider
          ? 'Сервис поиска временно недоступен. Можно ввести название вручную.'
          : 'Не удалось загрузить настройки поиска.');
      }
      try { return await response.json(); } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new GeocoderError(provider ? 'invalid-response' : 'configuration', 'Сервис вернул некорректные данные.');
      }
    } catch (error) {
      abortIfNeeded(signal);
      if (timedOut) throw new GeocoderError('timeout', 'Сервис поиска не ответил вовремя. Попробуйте ещё раз или введите название вручную.');
      if (error instanceof GeocoderError) throw error;
      throw new GeocoderError('network', 'Нет связи с сервисом поиска. Можно ввести название вручную.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function loadBaseUrl(): Promise<string> {
    configPromise ??= fetchJson(configUrl).then(value => {
      const base = record(record(value).geocoding).baseUrl;
      try {
        if (typeof base !== 'string') throw new Error();
        const url = new URL(base, typeof location !== 'undefined' ? location.origin : 'http://localhost');
        const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
          || url.username || url.password || url.search || url.hash) throw new Error();
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        return url.href;
      } catch { throw new GeocoderError('configuration', 'В настройках указан некорректный адрес сервиса поиска.'); }
    }).catch(error => { configPromise = undefined; throw error; });
    return configPromise;
  }

  function cached(key: string): PlaceCandidate[] | undefined {
    // Another tab may have filled this cache while the request waited for its lock.
    refreshCache();
    const item = cache.find(entry => entry.key === key && entry.expires > Date.now());
    return item ? structuredClone(item.data) : undefined;
  }

  async function request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<PlaceCandidate[]> {
    abortIfNeeded(signal);
    const baseUrl = await loadBaseUrl();
    abortIfNeeded(signal);
    const url = new URL(path, baseUrl);
    url.search = new URLSearchParams({ format: 'jsonv2', 'accept-language': 'ru', addressdetails: '1', namedetails: '1', ...params }).toString();
    const hit = cached(url.href);
    if (hit) return hit;
    if (!locks) throw new GeocoderError('unsupported', 'Для безопасного поиска нужен браузер с Web Locks и HTTPS или localhost. Название можно ввести вручную.');
    readRate();
    checkCooldown();

    const run = async () => locks.request(LOCK_KEY, { mode: 'exclusive', signal }, async () => {
      abortIfNeeded(signal);
      const queuedHit = cached(url.href);
      if (queuedHit) return queuedHit;
      readRate();
      checkCooldown();
      // Always wait on acquisition, even if storage reads work. A prior tab may
      // have hit a write quota and then closed, releasing its lock immediately.
      // This also protects reloads and transitions in storage availability.
      const delay = Math.max(INTERVAL_MS, rate.lastDispatch + INTERVAL_MS - Date.now());
      await wait(delay, signal);
      abortIfNeeded(signal);
      rate.lastDispatch = Date.now();
      writeRate();
      {
        const raw = await fetchJson(url.href, signal, true);
        abortIfNeeded(signal);
        let places: PlaceCandidate[];
        if (path === 'search') {
          if (!Array.isArray(raw)) throw new GeocoderError('invalid-response', 'Сервис вернул некорректные результаты поиска.');
          const seen = new Set<string>();
          places = raw.slice(0, 20).map(parsePlace).filter((place): place is PlaceCandidate => place !== null)
            .filter(place => {
              const key = place.osmRef ?? `${place.name}|${place.coordinates.join(',')}`;
              if (seen.has(key)) return false;
              seen.add(key); return true;
            }).slice(0, 8);
        } else {
          const place = parsePlace(raw);
          if (!place) throw new GeocoderError('no-result', 'Населённый пункт не найден. Можно ввести название вручную.');
          places = [place];
        }
        cache = cache.filter(entry => entry.key !== url.href && entry.expires > Date.now());
        cache.push({ key: url.href, expires: Date.now() + CACHE_TTL_MS, data: places });
        cache = cache.slice(-CACHE_LIMIT);
        try { storage?.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* Memory cache remains available. */ }
        return structuredClone(places);
      }
    });
    const result = tail.then(run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async searchCities(query, signal) {
      const normalized = query.trim().replace(/\s+/g, ' ');
      if (normalized.length < 2 || normalized.length > 200) {
        throw new GeocoderError('invalid-input', 'Введите название от 2 до 200 символов.');
      }
      return request('search', { q: normalized, limit: '8', featureType: 'city', layer: 'address' }, signal);
    },
    async reverseGeocode(coordinates, signal) {
      if (!validCoordinates(coordinates)) throw new GeocoderError('invalid-input', 'Некорректные координаты точки.');
      const [lng, lat] = coordinates;
      const places = await request('reverse', { lon: lng.toFixed(6), lat: lat.toFixed(6), zoom: '10', layer: 'address' }, signal);
      // The API finds a nearby OSM object, not necessarily the actual clicked point.
      return { ...places[0], coordinates: [lng, lat] };
    },
  };
}
