import { describe, expect, it, vi } from 'vitest';
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { createMapThemeController, darkPaint } from './theme';

describe('map theme', () => {
  it('colors the basemap without modifying travel colors, and restores original expressions', () => {
    const original = ['case', ['==', ['get', 'class'], 'park'], '#00ff00', '#eeeeee'];
    const originalText = ['case', ['has', 'name:ru'], '#121212', '#353535'];
    const layers: LayerSpecification[] = [
      { id: 'land', type: 'fill', source: 'base', paint: { 'fill-color': original as never } },
      { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#aabbcc' } },
      { id: 'travel-countries-fill', type: 'fill', source: 'travel-countries', paint: { 'fill-color': '#ff00ff' } },
      { id: 'labels', type: 'symbol', source: 'base' },
      { id: 'road_name', type: 'symbol', source: 'base', 'source-layer': 'transportation_name', paint: { 'text-color': originalText as never } },
      { id: 'highway-shield-non-us', type: 'symbol', source: 'base', 'source-layer': 'transportation_name',
        layout: { 'icon-image': ['concat', 'road_', ['get', 'ref_length']], 'text-field': ['to-string', ['get', 'ref']] },
        paint: { 'text-color': originalText as never, 'text-halo-color': '#ffffff' } },
    ];
    const paint = vi.fn();
    const sky = vi.fn();
    const map = { getStyle: () => ({ layers }), getSky: () => undefined, getLayer: () => true, setPaintProperty: paint, setSky: sky };
    const apply = createMapThemeController(map as unknown as MapLibreMap);
    apply('dark');
    expect(paint).toHaveBeenCalledWith('water', 'fill-color', '#122e3b');
    expect(paint.mock.calls.some(([id]) => id === 'travel-countries-fill')).toBe(false);
    expect(paint).toHaveBeenCalledWith('road_name', 'text-color', '#d2dddd');
    const count = paint.mock.calls.length;
    apply('dark');
    expect(paint).toHaveBeenCalledTimes(count);
    apply('light');
    expect(paint).toHaveBeenCalledWith('land', 'fill-color', original);
    expect(paint).toHaveBeenCalledWith('labels', 'text-halo-color', undefined);
    expect(paint).toHaveBeenCalledWith('road_name', 'text-color', originalText);
    expect(paint.mock.calls.some(([id]) => id === 'highway-shield-non-us')).toBe(false);
    expect(sky).toHaveBeenLastCalledWith(undefined);
  });

  it.each(['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us'])('preserves text on the white Liberty raster shield %s', id => {
    const shield: LayerSpecification = {
      id, type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name',
      layout: {
        'icon-image': id === 'highway-shield-non-us'
          ? ['concat', 'road_', ['get', 'ref_length']]
          : ['concat', ['get', 'network'], '_', ['get', 'ref_length']],
        'text-field': ['to-string', ['get', 'ref']],
      },
    };
    expect(darkPaint(shield)).toEqual({});
    // A road-name label or a route number without its white sprite still needs
    // ordinary light text on the dark basemap.
    expect(darkPaint({ ...shield, id: 'road_name', layout: { 'text-field': ['get', 'name'] } })['text-color']).toBe('#d2dddd');
    expect(darkPaint({ ...shield, layout: { 'text-field': ['get', 'ref'] } })['text-color']).toBe(id === 'highway-shield-us-interstate' ? '#edf1ee' : '#d2dddd');
  });

  it('keeps geography types distinct and skips unsupported layers', () => {
    expect(darkPaint({ id: 'ocean', type: 'background' })).toEqual({ 'background-color': '#1b262c' });
    expect(darkPaint({ id: 'forest', type: 'fill', source: 'base' })['fill-color']).not.toEqual(darkPaint({ id: 'water', type: 'fill', source: 'base' })['fill-color']);
    expect(darkPaint({ id: 'raster', type: 'raster', source: 'base' })).toEqual({});
  });
});
