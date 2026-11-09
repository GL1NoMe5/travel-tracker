import { describe, expect, it, vi } from 'vitest';
import { createCity, createEmptyData, createVisit } from '../domain/tracker';
import { loadTracker, parseBackup, persistTracker, recoverTracker, RECOVERY_KEY_PREFIX, serializeBackup, STORAGE_KEY, type StorageAdapter } from './persistence';

function memory(raw: string | null = null): StorageAdapter {
  const values = new Map<string, string>(); if (raw !== null) values.set(STORAGE_KEY, raw);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
describe('snapshots and backups', () => {
  it('round-trips multiple visits and colors', () => {
    const city = createCity({ name: 'Алматы', displayName: 'Алматы', coordinates: [76.9, 43.2] });
    city.visits.push({ ...createVisit(), date: '2025-12-31', note: 'Горы <script>text</script>' });
    const data = { ...createEmptyData(), countryColors: { KZ: '#46A88C' }, cities: [city] };
    const store = memory(); persistTracker(store, data);
    expect(loadTracker(store).data).toEqual(data);
    expect(parseBackup(serializeBackup(data))).toEqual(data);
  });
  it('does not overwrite corrupt JSON when loading', () => {
    const store = memory('{broken');
    const result = loadTracker(store);
    expect(result.kind).toBe('corrupt');
    expect(result.raw).toBe('{broken');
    expect(store.getItem(STORAGE_KEY)).toBe('{broken');
  });
  it('preserves the exact damaged raw snapshot before starting an empty collection', () => {
    const store = memory('{broken');
    const writes: string[] = [];
    const recovery = recoverTracker({
      getItem: store.getItem,
      setItem(key, value) { writes.push(key); store.setItem(key, value); },
    }, '{broken');
    expect(recovery.kind).toBe('ok');
    if (recovery.kind !== 'ok') throw new Error('Expected successful recovery');
    expect(recovery.recoveryKey.startsWith(RECOVERY_KEY_PREFIX)).toBe(true);
    expect(writes).toEqual([recovery.recoveryKey, STORAGE_KEY]);
    expect(store.getItem(recovery.recoveryKey)).toBe('{broken');
    expect(loadTracker(store).data).toEqual(createEmptyData());
  });
  it('leaves the original untouched if writing the recovery snapshot fails', () => {
    const store = memory('{broken');
    const writes: string[] = [];
    const failingStore: StorageAdapter = {
      getItem: store.getItem,
      setItem(key) { writes.push(key); throw new Error('quota'); },
    };
    expect(() => recoverTracker(failingStore, '{broken')).toThrow('quota');
    expect(writes).toHaveLength(1);
    expect(writes[0].startsWith(RECOVERY_KEY_PREFIX)).toBe(true);
    expect(store.getItem(STORAGE_KEY)).toBe('{broken');
  });
  it('keeps previous recovery snapshots when retrying a failed reset with a colliding key', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    try {
      const store = memory('{broken');
      const recoveryKeys: string[] = [];
      let failReset = true;
      const failingStore: StorageAdapter = {
        getItem: store.getItem,
        setItem(key, value) {
          if (key === STORAGE_KEY && failReset) throw new Error('reset failed');
          if (key.startsWith(RECOVERY_KEY_PREFIX)) recoveryKeys.push(key);
          store.setItem(key, value);
        },
      };
      expect(() => recoverTracker(failingStore, '{broken')).toThrow('reset failed');
      expect(store.getItem(STORAGE_KEY)).toBe('{broken');
      failReset = false;
      expect(recoverTracker(failingStore, '{broken').kind).toBe('ok');
      expect(new Set(recoveryKeys).size).toBe(2);
      for (const key of recoveryKeys) expect(store.getItem(key)).toBe('{broken');
    } finally {
      clock.mockRestore();
      uuid.mockRestore();
    }
  });
  it('does not replace newer data written before recovery gets the lock', () => {
    const winner = serializeBackup({ ...createEmptyData(), countryColors: { FR: '#c45b3d' } });
    const store = memory(winner);
    const setItem = vi.fn(store.setItem);
    expect(recoverTracker({ getItem: store.getItem, setItem }, '{broken')).toEqual({ kind: 'conflict' });
    expect(setItem).not.toHaveBeenCalled();
    expect(store.getItem(STORAGE_KEY)).toBe(winner);
  });
  it('rejects future schemas and malformed imports atomically', () => {
    const store = memory(serializeBackup(createEmptyData()));
    const before = store.getItem(STORAGE_KEY);
    expect(() => parseBackup('{"schemaVersion":2}')).toThrow(/версия/);
    expect(() => parseBackup('null')).toThrow();
    expect(store.getItem(STORAGE_KEY)).toBe(before);
  });
  it('surfaces storage failures instead of claiming persistence', () => {
    const store: StorageAdapter = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
    expect(loadTracker(store).kind).toBe('unavailable');
    expect(() => persistTracker(store, createEmptyData())).toThrow('quota');
  });
  it('never produces an export larger than the supported import size', () => {
    const city = createCity({ name: 'Тест', displayName: 'Тест', coordinates: [0, 0] });
    city.visits = Array.from({ length: 500 }, () => ({ ...createVisit(), note: 'я'.repeat(1000) }));
    const cities = Array.from({ length: 6 }, () => ({ ...city, id: crypto.randomUUID(), visits: city.visits.map(visit => ({ ...visit, id: crypto.randomUUID() })) }));
    const store = memory(serializeBackup(createEmptyData()));
    expect(() => persistTracker(store, { ...createEmptyData(), cities })).toThrow(/5 МБ/);
    expect(loadTracker(store).data.cities).toEqual([]);
  });
});
