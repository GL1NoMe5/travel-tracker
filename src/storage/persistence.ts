import { createEmptyData, MAX_IMPORT_BYTES, validateTrackerData } from '../domain/tracker';
import type { TrackerData } from '../domain/types';

export const STORAGE_KEY = 'travel-tracker:data:v1';
export const RECOVERY_KEY_PREFIX = 'travel-tracker:recovery:';
export interface StorageAdapter { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type LoadResult =
  | { kind: 'ok' | 'empty'; data: TrackerData; raw: string | null }
  | { kind: 'corrupt'; data: TrackerData; raw: string; message: string }
  | { kind: 'unavailable'; data: TrackerData; raw: null; message: string };

export function browserStorage(): StorageAdapter {
  return { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) };
}

export function parseBackup(raw: string): TrackerData {
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error('Размер файла превышает 5 МБ.');
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error('Файл не является корректным JSON.'); }
  const data = validateTrackerData(input);
  // The canonical export must also fit the import limit after formatting.
  assertBackupSize(JSON.stringify(data, null, 2));
  return data;
}

export function loadTracker(storage: StorageAdapter): LoadResult {
  let raw: string | null;
  try { raw = storage.getItem(STORAGE_KEY); }
  catch { return { kind: 'unavailable', data: createEmptyData(), raw: null, message: 'Браузер не разрешает сохранять путешествия. Изменения останутся только в этой вкладке.' }; }
  if (raw === null) return { kind: 'empty', data: createEmptyData(), raw };
  try { return { kind: 'ok', data: parseBackup(raw), raw }; }
  catch { return { kind: 'corrupt', data: createEmptyData(), raw, message: 'Не удалось прочитать сохранённые места. Данные оставлены без изменений.' }; }
}

export function serializeBackup(data: TrackerData): string {
  const raw = JSON.stringify(validateTrackerData(data), null, 2);
  assertBackupSize(raw);
  return raw;
}

function assertBackupSize(raw: string): void {
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) throw new Error('Коллекция превысила доступный объём (5 МБ). Последние изменения не сохранены.');
}

export function persistTracker(storage: StorageAdapter, data: TrackerData): void {
  // Do not replace the previous snapshot until serialization has succeeded.
  storage.setItem(STORAGE_KEY, serializeBackup(data));
}

type RecoveryResult =
  | { kind: 'conflict' }
  | { kind: 'ok'; data: TrackerData; raw: string; recoveryKey: string };

/** Call inside the normal write lock. A failed backup must never clear the original. */
export function recoverTracker(storage: StorageAdapter, damagedRaw: string): RecoveryResult {
  if (storage.getItem(STORAGE_KEY) !== damagedRaw) return { kind: 'conflict' };
  const data = createEmptyData();
  const raw = serializeBackup(data);
  const baseKey = `${RECOVERY_KEY_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const recoveryKey = attempt ? `${baseKey}-${attempt}` : baseKey;
    if (storage.getItem(recoveryKey) !== null) continue;
    storage.setItem(recoveryKey, damagedRaw);
    storage.setItem(STORAGE_KEY, raw);
    return { kind: 'ok', data, raw, recoveryKey };
  }
  throw new Error('Не удалось создать копию прежних данных.');
}

