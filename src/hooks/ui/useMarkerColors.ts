import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MARKER_COLORS, type MarkerColors } from '../../map/markerColors';
export { DEFAULT_MARKER_COLORS, type MarkerColors } from '../../map/markerColors';
export const MARKER_COLORS_STORAGE_KEY = 'travel-tracker:marker-colors:v1';

const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

/** Invalid preferences fall back in memory; reading never repairs stored bytes. */
export function parseMarkerColors(raw: string | null): MarkerColors | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const colors = value as Record<string, unknown>;
    if (!isColor(colors.visited) || !isColor(colors.wishlist)) return null;
    return { visited: colors.visited.toUpperCase(), wishlist: colors.wishlist.toUpperCase() };
  } catch { return null; }
}

function savedMarkerColors(): MarkerColors {
  try { return parseMarkerColors(localStorage.getItem(MARKER_COLORS_STORAGE_KEY)) ?? { ...DEFAULT_MARKER_COLORS }; }
  catch { return { ...DEFAULT_MARKER_COLORS }; }
}

export function useMarkerColors() {
  const [markerColors, setMarkerColors] = useState<MarkerColors>(savedMarkerColors);
  // A ref keeps consecutive color-picker events from overwriting one another.
  const current = useRef(markerColors);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== MARKER_COLORS_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.storageArea && event.storageArea !== localStorage) return;
      } catch { return; }
      const next = savedMarkerColors();
      current.current = next;
      setMarkerColors(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMarkerColor = useCallback((kind: keyof MarkerColors, color: string) => {
    if (!isColor(color)) return;
    const next = { ...current.current, [kind]: color.toUpperCase() };
    current.current = next;
    setMarkerColors(next);
    try { localStorage.setItem(MARKER_COLORS_STORAGE_KEY, JSON.stringify(next)); }
    catch { /* Preferences remain usable for this session if storage is unavailable. */ }
  }, []);

  const resetMarkerColors = useCallback(() => {
    const next = { ...DEFAULT_MARKER_COLORS };
    current.current = next;
    setMarkerColors(next);
    try { localStorage.removeItem(MARKER_COLORS_STORAGE_KEY); }
    catch { /* Reset still applies to this session. */ }
  }, []);

  return { markerColors, setMarkerColor, resetMarkerColors };
}
