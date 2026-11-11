import type { LayerSpecification, Map as MapLibreMap, SkySpecification } from 'maplibre-gl';
import type { Theme } from '../hooks/ui/useTheme';

const LIBERTY_ROAD_SHIELDS = new Set(['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us']);

/** Only basemap colors change; user-selected country colors are never recolored. */
export function darkPaint(layer: LayerSpecification): Record<string, string> {
  if (layer.id.startsWith('travel-') || ('source' in layer && layer.source === 'travel-countries')) return {};
  if (layer.type === 'symbol' && LIBERTY_ROAD_SHIELDS.has(layer.id)
    && layer['source-layer'] === 'transportation_name' && layer.layout?.['icon-image']) {
    const field = JSON.stringify(layer.layout['text-field']);
    if (field === '"{ref}"' || field === '["get","ref"]' || field === '["to-string",["get","ref"]]') {
      // Liberty pairs route numbers with white, non-SDF road_/us-* sprites.
      // Preserve their original text paint together with that unchanged artwork.
      return {};
    }
  }
  const name = `${layer.id} ${'source-layer' in layer ? layer['source-layer'] : ''}`;
  const water = /water|ocean|lake|river/i.test(name);
  switch (layer.type) {
    case 'background': return { 'background-color': '#1b262c' };
    case 'fill': return {
      'fill-color': water ? '#122e3b' : /park|wood|forest|grass|landcover/i.test(name) ? '#283b32'
        : /building/i.test(name) ? '#3b474b' : '#29363b',
      ...('fill-outline-color' in (layer.paint ?? {}) ? { 'fill-outline-color': '#45565b' } : {}),
    };
    case 'fill-extrusion': return { 'fill-extrusion-color': '#3b474b' };
    case 'line': return { 'line-color': water ? '#385c6b' : /boundary|border|admin/i.test(name) ? '#78878d'
      : /casing|outline|tunnel/i.test(name) ? '#1c272d'
        : /motorway|trunk|primary/i.test(name) ? '#8a8270' : '#56676d' };
    case 'symbol': return {
      'text-color': water ? '#a6cad6' : /country|state/i.test(name) ? '#edf1ee' : '#d2dddd',
      'text-halo-color': '#19262c',
      ...('icon-color' in (layer.paint ?? {}) ? { 'icon-color': '#adbdbf' } : {}),
    };
    case 'hillshade': return { 'hillshade-shadow-color': '#14251e', 'hillshade-highlight-color': '#516357', 'hillshade-accent-color': '#263e32' };
    default: return {};
  }
}

export function createMapThemeController(map: Pick<MapLibreMap, 'getStyle' | 'getSky' | 'setSky' | 'getLayer' | 'setPaintProperty'>) {
  const layers = map.getStyle().layers ?? [];
  const originals = layers.flatMap(layer => Object.entries(darkPaint(layer)).map(([property, dark]) => ({
    id: layer.id, property, dark,
    light: (layer.paint as Record<string, unknown> | undefined)?.[property],
  })));
  const originalSky = map.getSky();
  let applied: Theme = 'light';
  return (theme: Theme) => {
    if (theme === applied) return;
    for (const { id, property, dark, light } of originals) {
      if (map.getLayer(id)) map.setPaintProperty(id,
        property as Parameters<MapLibreMap['setPaintProperty']>[1],
        (theme === 'dark' ? dark : light) as Parameters<MapLibreMap['setPaintProperty']>[2]);
    }
    // MapLibre accepts undefined here to restore a style that had no sky block.
    map.setSky(theme === 'dark' ? {
      'sky-color': '#151e24', 'horizon-color': '#243b46', 'fog-color': '#1b2d35',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.9,
      'atmosphere-blend': 0.3,
    } : originalSky as SkySpecification);
    applied = theme;
  };
}
