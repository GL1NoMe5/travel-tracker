import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGeocoder, GeocoderError, type GeocoderLockManager } from './index';
import { createCity, createEmptyData, validateTrackerData } from '../../domain/tracker';

const CONFIG = { geocoding: { baseUrl: 'https://nominatim.example.test/' } };
const PARIS = {
  osm_type: 'relation', osm_id: 7444, lat: '48.8566', lon: '2.3522',
  name: 'Paris', addresstype: 'city', type: 'administrative',
  display_name: 'Париж, Иль-де-Франс, Франция',
  address: { city: 'Париж', state: 'Иль-де-Франс', country_code: 'fr' },
  namedetails: { 'name:ru': 'Париж' },
};

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class TestLocks implements GeocoderLockManager {
  private tail: Promise<unknown> = Promise.resolve();
  request<T>(_name: string, options: { mode: 'exclusive'; signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return callback();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function harness(handler?: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  const storage = new MemoryStorage();
  const locks = new TestLocks();
  const dispatches: { url: URL; at: number; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = String(input);
    if (urlText.endsWith('config.json')) return Response.json(CONFIG);
    const url = new URL(urlText);
    dispatches.push({ url, at: Date.now(), init });
    return handler ? handler(url, init) : Response.json(url.pathname === '/search' ? [PARIS] : PARIS);
  });
  const options = { storage, locks, fetch: fetcher as typeof fetch, configUrl: '/config.json' };
  return { ...options, options, dispatches, fetcher, client: createGeocoder(options) };
}

async function complete<T>(promise: Promise<T>): Promise<T> {
  const observed = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await observed;
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('explicit Nominatim requests', () => {
  it('is lazy, localizes a submitted city search, and isolates cached results from mutations', async () => {
    const h = harness();
    expect(h.fetcher).not.toHaveBeenCalled();
    const results = await complete(h.client.searchCities('  Париж   Франция  '));
    expect(results).toEqual([expect.objectContaining({
      name: 'Париж', countryCode: 'FR', coordinates: [2.3522, 48.8566], osmRef: 'relation:7444',
    })]);
    expect(h.dispatches[0].url.searchParams.get('accept-language')).toBe('ru');
    expect(h.dispatches[0].url.searchParams.get('featureType')).toBe('city');
    expect(h.dispatches[0].url.searchParams.get('q')).toBe('Париж Франция');
    expect(h.dispatches[0].init?.referrerPolicy).toBe('strict-origin-when-cross-origin');
    results[0].name = 'Changed';
    const cached = await h.client.searchCities('Париж Франция');
    expect(cached[0].name).toBe('Париж');
    expect(h.dispatches).toHaveLength(1);
    const reopened = createGeocoder(h.options);
    expect((await reopened.searchCities('Париж Франция'))[0].name).toBe('Париж');
    expect(h.dispatches).toHaveLength(1);
  });

  it('preserves the exact map coordinates, even when the response or cached key has different coordinates', async () => {
    const h = harness();
    const result = await complete(h.client.reverseGeocode([2.35312345, 48.85798765]));
    expect(result.coordinates).toEqual([2.35312345, 48.85798765]);
    expect(h.dispatches[0].url.searchParams.get('zoom')).toBe('10');
    const nearby = await h.client.reverseGeocode([2.35312346, 48.85798766]);
    expect(nearby.coordinates).toEqual([2.35312346, 48.85798766]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('filters invalid and duplicate results without turning an administrative region into a city', async () => {
    const h = harness(() => Response.json([
      PARIS, PARIS, { ...PARIS, lon: 'NaN' },
      { name: 'Region', type: 'administrative', addresstype: 'state', lon: 5, lat: 6, address: { state: 'Region' } },
    ]));
    expect(await complete(h.client.searchCities('Paris'))).toHaveLength(1);
  });

  it('bounds provider fields to a candidate that can be saved by the domain', async () => {
    const h = harness(() => Response.json([{
      ...PARIS, namedetails: { 'name:ru': 'Я'.repeat(200) }, display_name: 'Д'.repeat(800),
      address: { city: 'Г'.repeat(400), state: 'О'.repeat(400), county: 'Р'.repeat(400), country_code: 'fr' },
    }]));
    const [candidate] = await complete(h.client.searchCities('Paris'));
    expect(candidate.name).toHaveLength(120);
    expect(candidate.localityName).toHaveLength(300);
    expect(candidate.regionName).toHaveLength(500);
    expect(candidate.displayName).toHaveLength(500);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [createCity(candidate)] })).not.toThrow();
  });

  it('does not coerce boolean or array coordinates, and never emits zero OSM identifiers', async () => {
    const h = harness(() => Response.json([
      { ...PARIS, lon: true }, { ...PARIS, lat: false }, { ...PARIS, lon: [2.35] },
      { ...PARIS, osm_id: 0 },
    ]));
    const candidates = await complete(h.client.searchCities('Paris'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].osmRef).toBeUndefined();
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [createCity(candidates[0])] })).not.toThrow();
  });

  it('returns no-result for a reverse response without a locality', async () => {
    const h = harness(() => Response.json({ error: 'Unable to geocode' }));
    await expect(complete(h.client.reverseGeocode([0, 0]))).rejects.toMatchObject({ code: 'no-result' });
  });

  it('rejects bad input without making any request', async () => {
    const h = harness();
    await expect(h.client.searchCities(' ')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(h.client.reverseGeocode([181, 0])).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(h.client.reverseGeocode([0, NaN])).rejects.toMatchObject({ code: 'invalid-input' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe('rate limiting and cancellation', () => {
  it('serializes search and reverse across client instances with a shared cross-tab lock', async () => {
    const h = harness();
    const otherTab = createGeocoder(h.options);
    const first = h.client.searchCities('Париж');
    const second = otherTab.reverseGeocode([2.35, 48.85]);
    await complete(Promise.all([first, second]));
    expect(h.dispatches).toHaveLength(2);
    expect(h.dispatches[1].at - h.dispatches[0].at).toBeGreaterThanOrEqual(1100);
  });

  it('uses a cache entry written by another tab while waiting in the queue', async () => {
    const h = harness();
    const otherTab = createGeocoder(h.options);
    const results = await complete(Promise.all([
      h.client.searchCities('Париж'), otherTab.searchCities('Париж'),
    ]));
    expect(results[0]).toEqual(results[1]);
    expect(h.dispatches).toHaveLength(1);
  });

  it('retains the dispatch interval when an active request is cancelled', async () => {
    let calls = 0;
    const h = harness((_url, init) => {
      if (++calls > 1) return Response.json([PARIS]);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const controller = new AbortController();
    const first = h.client.searchCities('Paris', controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.dispatches).toHaveLength(1);
    controller.abort();
    const next = createGeocoder(h.options).searchCities('London');
    await complete(next);
    expect((await first).name).toBe('AbortError');
    expect(h.dispatches[1].at - h.dispatches[0].at).toBeGreaterThanOrEqual(1100);
  });

  it('does not dispatch a cancelled queued request', async () => {
    const h = harness();
    const controller = new AbortController();
    const first = h.client.searchCities('Paris');
    const queued = h.client.searchCities('London', controller.signal).catch(error => error);
    controller.abort();
    await complete(first);
    expect((await queued).name).toBe('AbortError');
    expect(h.dispatches).toHaveLength(1);
  });

  it('honors Retry-After across client instances without automatically retrying', async () => {
    const h = harness(() => new Response('', { status: 429, headers: { 'Retry-After': '2' } }));
    await expect(complete(h.client.searchCities('Paris'))).rejects.toMatchObject({ code: 'rate-limit' });
    const otherTab = createGeocoder(h.options);
    await expect(otherTab.searchCities('London')).rejects.toMatchObject({ code: 'rate-limit' });
    expect(h.dispatches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(complete(otherTab.searchCities('London'))).rejects.toBeInstanceOf(GeocoderError);
    expect(h.dispatches).toHaveLength(2);
    expect(h.dispatches[1].at - h.dispatches[0].at).toBeGreaterThanOrEqual(2000);
  });

  it('times out a stalled request with an actionable error', async () => {
    const h = harness((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    await expect(complete(h.client.searchCities('Paris'))).rejects.toMatchObject({ code: 'timeout' });
    expect(h.dispatches).toHaveLength(1);
  });
});

describe('configuration and storage failures', () => {
  it('fails closed without cross-tab coordination, allowing the UI to offer manual entry', async () => {
    const h = harness();
    const client = createGeocoder({ ...h.options, locks: null });
    await expect(client.searchCities('Paris')).rejects.toMatchObject({ code: 'unsupported' });
    expect(h.dispatches).toHaveLength(0);
  });

  it('keeps working with unavailable storage and applies a conservative extra delay', async () => {
    const h = harness();
    const broken = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota'); },
    };
    const start = Date.now();
    const client = createGeocoder({ ...h.options, storage: broken });
    expect(await complete(client.searchCities('Paris'))).toHaveLength(1);
    expect(h.dispatches[0].at - start).toBeGreaterThanOrEqual(1100);
    expect(await client.searchCities('Paris')).toHaveLength(1);
    expect(h.dispatches).toHaveLength(1);
  });

  it('retains the safe startup interval in a new tab when storage reads succeed but timestamp writes fail', async () => {
    const h = harness();
    const readOnly = {
      getItem() { return null; },
      setItem() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    };
    const first = createGeocoder({ ...h.options, storage: readOnly });
    await complete(first.searchCities('Paris'));
    // No timestamp could be persisted. A new tab must still wait after acquiring the lock.
    const reopened = createGeocoder({ ...h.options, storage: readOnly });
    await complete(reopened.searchCities('London'));
    expect(h.dispatches).toHaveLength(2);
    expect(h.dispatches[1].at - h.dispatches[0].at).toBeGreaterThanOrEqual(1100);
  });

  it.each([
    { name: 'Я'.repeat(121) },
    { localityName: 'Г'.repeat(301) },
    { regionName: 'Р'.repeat(501) },
    { osmRef: 'node:0' },
    { countryCode: 'fr' },
    { coordinates: [true, 48.85] },
  ])('ignores cached data that violates domain bounds: %j', async patch => {
    const h = harness();
    await complete(h.client.searchCities('Paris'));
    const entries = JSON.parse(h.storage.getItem('travel-tracker:geocoder-cache:v1')!);
    Object.assign(entries[0].data[0], patch);
    h.storage.setItem('travel-tracker:geocoder-cache:v1', JSON.stringify(entries));
    const reopened = createGeocoder(h.options);
    const [candidate] = await complete(reopened.searchCities('Paris'));
    expect(h.dispatches).toHaveLength(2);
    expect(() => validateTrackerData({ ...createEmptyData(), cities: [createCity(candidate)] })).not.toThrow();
  });

  it('loads the runtime provider address without assuming the public service URL', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/config.json') return Response.json({ geocoding: { baseUrl: 'https://my.example/geocoder' } });
      urls.push(url);
      return Response.json([PARIS]);
    });
    const client = createGeocoder({ fetch: fetcher as typeof fetch, locks: new TestLocks(), storage: new MemoryStorage(), configUrl: '/config.json' });
    await complete(client.searchCities('Paris'));
    expect(urls[0]).toMatch(/^https:\/\/my\.example\/geocoder\/search\?/);
  });

  it('rejects a malformed search response and does not persist it', async () => {
    const h = harness(() => Response.json({ unexpected: true }));
    await expect(complete(h.client.searchCities('Paris'))).rejects.toMatchObject({ code: 'invalid-response' });
    expect(h.storage.getItem('travel-tracker:geocoder-cache:v1')).toBeNull();
  });
});
