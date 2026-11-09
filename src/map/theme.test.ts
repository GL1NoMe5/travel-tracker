import { describe, expect, it, vi } from 'vitest';
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { createMapThemeController, darkPaint } from './theme';

describe('map theme', () => {
  it('colors the basemap without modifying travel colors, and restores original expressions', () => {
    const original = ['case', ['==', ['get', 'class'], 'park'], '#00ff00', '#eeeeee'];
    const layers: LayerSpecification[] = [
      { id: 'land', type: 'fill', source: 'base', paint: { 'fill-color': original as never } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#aabbcc' } },
      { id: 'travel-countries-fill', type: 'fill', source: 'travel-countries', paint: { 'fill-color': '#ff00ff' } },
      { id: 'labels', type: 'symbol', source: 'base' },
    ];
    const paint = vi.fn();
    const sky = vi.fn();
    const map = { getStyle: () => ({ layers }), getSky: () => undefined, getLayer: () => true, setPaintProperty: paint, setSky: sky };
    const apply = createMapThemeController(map as unknown as MapLibreMap);
    apply('dark');
    expect(paint).toHaveBeenCalledWith('water', 'fill-color', '#122e3b');
    expect(paint.mock.calls.some(([id]) => id === 'travel-countries-fill')).toBe(false);
    const count = paint.mock.calls.length;
    apply('dark');
    expect(paint).toHaveBeenCalledTimes(count);
    apply('light');
    expect(paint).toHaveBeenCalledWith('land', 'fill-color', original);
    expect(paint).toHaveBeenCalledWith('labels', 'text-halo-color', undefined);
    expect(sky).toHaveBeenLastCalledWith(undefined);
  });

  it('keeps geography types distinct and skips unsupported layers', () => {
    expect(darkPaint({ id: 'ocean', type: 'background' })).toEqual({ 'background-color': '#1b262c' });
    expect(darkPaint({ id: 'forest', type: 'fill', source: 'base' })['fill-color']).not.toEqual(darkPaint({ id: 'water', type: 'fill', source: 'base' })['fill-color']);
    expect(darkPaint({ id: 'raster', type: 'raster', source: 'base' })).toEqual({});
  });
});
