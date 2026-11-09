import { useEffect, useRef, useState } from 'react';
import { trackerReducer, type TrackerAction } from '../domain/tracker';
import { browserStorage, loadTracker, recoverTracker, serializeBackup, STORAGE_KEY } from './persistence';

const storage = browserStorage();

export function useTracker() {
  const [initial] = useState(() => loadTracker(storage));
  const [data, setData] = useState(initial.data);
  const current = useRef(data);
  const expectedRaw = useRef(initial.raw);
  type Issue = { kind: 'corrupt' | 'unavailable' | 'conflict' | 'validation'; message: string } | null;
  const [issue, setIssueState] = useState<Issue>(
    initial.kind === 'corrupt' || initial.kind === 'unavailable' ? { kind: initial.kind, message: initial.message } : null,
  );
  const issueRef = useRef(issue);
  function setIssue(value: Issue) { issueRef.current = value; setIssueState(value); }
  const [damagedRaw, setDamagedRaw] = useState(initial.kind === 'corrupt' ? initial.raw : null);
  const blocked = issue?.kind === 'corrupt' || issue?.kind === 'conflict';

  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if ((event.key === STORAGE_KEY || event.key === null) && event.newValue !== expectedRaw.current) {
        setIssue({ kind: 'conflict', message: 'Карта изменена в другой вкладке. Загрузите изменения, чтобы продолжить.' });
      }
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, []);

  async function commit(action: TrackerAction | (() => TrackerAction)): Promise<boolean> {
    const write = () => {
      if (issueRef.current?.kind === 'corrupt' || issueRef.current?.kind === 'conflict') return false;
      let next;
      let raw: string;
      try { next = trackerReducer(current.current, typeof action === 'function' ? action() : action); raw = serializeBackup(next); }
      catch (error) { setIssue({ kind: 'validation', message: error instanceof Error ? error.message : 'Изменения не сохранены.' }); return false; }
      try {
        if (storage.getItem(STORAGE_KEY) !== expectedRaw.current) {
          setIssue({ kind: 'conflict', message: 'Карта изменена в другой вкладке. Сначала загрузите изменения.' });
          return false;
        }
        storage.setItem(STORAGE_KEY, raw);
        expectedRaw.current = raw;
        setIssue(null);
      } catch {
        setIssue({ kind: 'unavailable', message: 'Не удалось сохранить изменения. Они пока доступны только в этой вкладке. Попробуйте сохранить ещё раз.' });
      }
      current.current = next;
      setData(next);
      return true;
    };
    // Lock the comparison AND the write: localStorage does not provide a CAS operation.
    if (navigator.locks) return navigator.locks.request('travel-tracker:write:v1', write);
    return write();
  }

  function reload() {
    const result = loadTracker(storage);
    current.current = result.data; setData(result.data); expectedRaw.current = result.raw;
    setDamagedRaw(result.kind === 'corrupt' ? result.raw : null);
    setIssue(result.kind === 'corrupt' || result.kind === 'unavailable' ? { kind: result.kind, message: result.message } : null);
  }

  function retrySave(): Promise<boolean> {
    // Resolve after acquiring the lock so a queued retry cannot erase a newer edit.
    return commit(() => ({ type: 'replace', data: current.current }));
  }

  /** Only called after explicit confirmation; recovery preserves the raw data on disk first. */
  async function recoverEmpty() {
    const write = () => {
      // A queued second reset must not clear edits made after the first reset succeeded.
      if (issueRef.current?.kind !== 'corrupt' || expectedRaw.current === null) return;
      try {
        const recovered = recoverTracker(storage, expectedRaw.current);
        if (recovered.kind === 'conflict') {
          setIssue({ kind: 'conflict', message: 'Карта изменена в другой вкладке. Сначала загрузите изменения.' }); return;
        }
        expectedRaw.current = recovered.raw;
        current.current = recovered.data; setData(recovered.data); setIssue(null);
      } catch {
        setIssue({ kind: 'corrupt', message: 'Не удалось начать заново. Прежние данные оставлены без изменений. Попробуйте ещё раз.' });
      }
    };
    if (navigator.locks) await navigator.locks.request('travel-tracker:write:v1', write);
    else write();
  }

  return { data, issue, blocked, damagedRaw, commit, reload, retrySave, recoverEmpty };
}
