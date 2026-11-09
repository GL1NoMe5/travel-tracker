import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  AttributionControl,
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
  type ErrorEvent as MapLibreErrorEvent,
  type MapLayerMouseEvent,
  type MapSourceDataEvent,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Globe2, Minus, Plus } from 'lucide-react';
import { COUNTRIES_GEOJSON_URL, COUNTRY_BY_CODE } from '../data/countries';
import type { City, LngLat } from '../domain/types';
import type { MapStatus, TravelMapHandle, TravelMapProps } from './contracts';
import {
  CITY_FOCUS_ZOOM,
  COUNTRIES_FILL_LAYER_ID,
  COUNTRIES_HIT_LAYER_ID,
  COUNTRIES_OUTLINE_LAYER_ID,
  COUNTRIES_SELECTED_FILL_LAYER_ID,
  COUNTRIES_SELECTED_OUTLINE_LAYER_ID,
  COUNTRIES_SOURCE_ID,
  GLOBE_TO_MERCATOR_PROJECTION,
  INITIAL_GLOBE_CENTER,
  LIBERTY_STYLE_URL,
  RUSSIAN_NAME_EXPRESSION,
  SELECTED_COUNTRY_FILL_OPACITY,
  SELECTED_COUNTRY_OUTLINE_OPACITY,
  buildCountryFillColorExpression,
  buildCountryFillOpacityExpression,
  buildCountryOutlineOpacityExpression,
  buildSelectedCountryOpacityExpression,
  classifyMapError,
  computeInitialGlobeZoom,
  extractCountryCodeFromFeatures,
  findCountryLayerAnchor,
  isCoordinateOccludedOnGlobe,
  isGeographicNameLayer,
  isValidLngLat,
  normalizeLngLat,
  resolveVisibleSurfacePoint,
} from './helpers';
import { measureDomViewportPadding, observeUiPanels } from './layout';
import { createMapThemeController } from './theme';
import './map.css';

setWorkerUrl(maplibreWorkerUrl);

type PendingCameraAction =
  | { type: 'country'; countryCode: string }
  | { type: 'city'; coordinates: LngLat; zoom?: number }
  | { type: 'reset' };

interface CityMarkerEntry {
  marker: Marker;
  element: HTMLButtonElement;
  coordinates: LngLat;
}

const FLAG_ICON_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
    <line x1="4" x2="4" y1="22" y2="15"></line>
  </svg>
`;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyRussianLabelsToStyle(map: MapLibreMap): void {
  const layers = map.getStyle()?.layers;
  if (!layers) return;

  for (const layer of layers) {
    // Keep the basemap quiet so personal places carry the accent.
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#edf0e8');
    if (layer.type === 'fill' && layer['source-layer'] === 'water') {
      map.setPaintProperty(layer.id, 'fill-color', '#bcd6dd');
    }
    let currentTextField: unknown;
    if (layer.type === 'symbol') {
      try {
        currentTextField = map.getLayoutProperty(layer.id, 'text-field');
      } catch {
        currentTextField = undefined;
      }
    }
    if (isGeographicNameLayer(layer, currentTextField)) {
      try {
        map.setLayoutProperty(layer.id, 'text-field', RUSSIAN_NAME_EXPRESSION);
      } catch {
        // Ignore layers that do not support dynamic text-field overrides
      }
    }
  }
}

function ensureCountrySourceAndLayers(
  map: MapLibreMap,
  countryColors: Readonly<Record<string, string>>,
  selectedCountryCode: string | null,
): void {
  if (!map.getSource(COUNTRIES_SOURCE_ID)) {
    map.addSource(COUNTRIES_SOURCE_ID, {
      type: 'geojson',
      data: COUNTRIES_GEOJSON_URL,
      promoteId: 'iso2',
      tolerance: 0.15,
    });
  }

  const layers = map.getStyle()?.layers ?? [];
  const beforeId = findCountryLayerAnchor(layers);
  const safeBeforeId = beforeId && map.getLayer(beforeId) ? beforeId : undefined;

  if (!map.getLayer(COUNTRIES_HIT_LAYER_ID)) {
    map.addLayer(
      {
        id: COUNTRIES_HIT_LAYER_ID,
        type: 'fill',
        source: COUNTRIES_SOURCE_ID,
        paint: {
          'fill-color': '#000000',
          'fill-opacity': 0.001,
        },
      },
      safeBeforeId,
    );
  }

  if (!map.getLayer(COUNTRIES_FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: COUNTRIES_FILL_LAYER_ID,
        type: 'fill',
        source: COUNTRIES_SOURCE_ID,
        paint: {
          'fill-color': buildCountryFillColorExpression(countryColors),
          'fill-opacity': buildCountryFillOpacityExpression(countryColors),
          'fill-antialias': true,
        },
      },
      safeBeforeId,
    );
  }

  if (!map.getLayer(COUNTRIES_OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: COUNTRIES_OUTLINE_LAYER_ID,
        type: 'line',
        source: COUNTRIES_SOURCE_ID,
        paint: {
          'line-color': buildCountryFillColorExpression(countryColors),
          'line-opacity': buildCountryOutlineOpacityExpression(countryColors),
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.8, 6, 1.5],
        },
      },
      safeBeforeId,
    );
  }

  if (!map.getLayer(COUNTRIES_SELECTED_FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: COUNTRIES_SELECTED_FILL_LAYER_ID,
        type: 'fill',
        source: COUNTRIES_SOURCE_ID,
        paint: {
          'fill-color': '#c45b3d',
          'fill-opacity': buildSelectedCountryOpacityExpression(
            selectedCountryCode,
            SELECTED_COUNTRY_FILL_OPACITY,
          ),
        },
      },
      safeBeforeId,
    );
  }

  if (!map.getLayer(COUNTRIES_SELECTED_OUTLINE_LAYER_ID)) {
    map.addLayer(
      {
        id: COUNTRIES_SELECTED_OUTLINE_LAYER_ID,
        type: 'line',
        source: COUNTRIES_SOURCE_ID,
        paint: {
          'line-color': '#b9492f',
          'line-opacity': buildSelectedCountryOpacityExpression(
            selectedCountryCode,
            SELECTED_COUNTRY_OUTLINE_OPACITY,
          ),
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 6, 2.6],
        },
      },
      safeBeforeId,
    );
  }
}

function syncCountryColorsPaint(
  map: MapLibreMap,
  countryColors: Readonly<Record<string, string>>,
): void {
  const fillColorExpr = buildCountryFillColorExpression(countryColors);
  const fillOpacityExpr = buildCountryFillOpacityExpression(countryColors);
  const outlineOpacityExpr = buildCountryOutlineOpacityExpression(countryColors);

  if (map.getLayer(COUNTRIES_FILL_LAYER_ID)) {
    map.setPaintProperty(COUNTRIES_FILL_LAYER_ID, 'fill-color', fillColorExpr);
    map.setPaintProperty(COUNTRIES_FILL_LAYER_ID, 'fill-opacity', fillOpacityExpr);
  }

  if (map.getLayer(COUNTRIES_OUTLINE_LAYER_ID)) {
    map.setPaintProperty(COUNTRIES_OUTLINE_LAYER_ID, 'line-color', fillColorExpr);
    map.setPaintProperty(COUNTRIES_OUTLINE_LAYER_ID, 'line-opacity', outlineOpacityExpr);
  }
}

function syncSelectedCountryPaint(
  map: MapLibreMap,
  selectedCountryCode: string | null,
): void {
  if (map.getLayer(COUNTRIES_SELECTED_FILL_LAYER_ID)) {
    map.setPaintProperty(
      COUNTRIES_SELECTED_FILL_LAYER_ID,
      'fill-opacity',
      buildSelectedCountryOpacityExpression(selectedCountryCode, SELECTED_COUNTRY_FILL_OPACITY),
    );
  }

  if (map.getLayer(COUNTRIES_SELECTED_OUTLINE_LAYER_ID)) {
    map.setPaintProperty(
      COUNTRIES_SELECTED_OUTLINE_LAYER_ID,
      'line-opacity',
      buildSelectedCountryOpacityExpression(
        selectedCountryCode,
        SELECTED_COUNTRY_OUTLINE_OPACITY,
      ),
    );
  }
}

function deduplicateCities(cities: readonly City[]): City[] {
  const seen = new Set<string>();
  const result: City[] = [];
  for (const city of cities) {
    if (!city || typeof city.id !== 'string' || seen.has(city.id)) continue;
    if (!isValidLngLat(city.coordinates)) continue;
    seen.add(city.id);
    result.push(city);
  }
  return result;
}

export const TravelMap = forwardRef<TravelMapHandle, TravelMapProps>(function TravelMap(
  {
    theme = 'light',
    mode,
    countryColors,
    selectedCountryCode,
    cities,
    selectedCityId,
    draftCoordinates,
    onCountrySelect,
    onCitySelect,
    onMapPointSelect,
    onStatusChange,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const styleReadyRef = useRef(false);
  const applyThemeRef = useRef<ReturnType<typeof createMapThemeController> | null>(null);
  const fatalErrorRef = useRef(false);
  const overviewRef = useRef(true);
  const cameraFrameRef = useRef<number | null>(null);
  const pendingCameraActionRef = useRef<PendingCameraAction | null>(null);
  const activeCameraActionRef = useRef<PendingCameraAction | null>(null);
  const cityMarkersRef = useRef<Map<string, CityMarkerEntry>>(new Map());
  const draftMarkerRef = useRef<{ marker: Marker; element: HTMLDivElement; coordinates: LngLat } | null>(
    null,
  );

  const [status, setStatus] = useState<MapStatus>({ kind: 'loading' });
  const [retryCount, setRetryCount] = useState(0);

  const propsRef = useRef({
    theme,
    mode,
    countryColors,
    selectedCountryCode,
    cities,
    selectedCityId,
    draftCoordinates,
    onCountrySelect,
    onCitySelect,
    onMapPointSelect,
    onStatusChange,
  });

  propsRef.current = {
    theme,
    mode,
    countryColors,
    selectedCountryCode,
    cities,
    selectedCityId,
    draftCoordinates,
    onCountrySelect,
    onCitySelect,
    onMapPointSelect,
    onStatusChange,
  };

  const reportStatus = useCallback((nextStatus: MapStatus) => {
    setStatus(nextStatus);
    propsRef.current.onStatusChange?.(nextStatus);
  }, []);

  const getCurrentPadding = useCallback(() => {
    const current = propsRef.current;
    const hasRightPanel =
      current.selectedCountryCode !== null ||
      current.selectedCityId !== null ||
      current.draftCoordinates !== null;
    return measureDomViewportPadding(canvasContainerRef.current, hasRightPanel);
  }, []);

  const syncMarkersOcclusion = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (cityMarkersRef.current.size === 0 && !draftMarkerRef.current) return;

    for (const entry of cityMarkersRef.current.values()) {
      const coveredByMapLibre = entry.element.classList.contains('maplibregl-marker-covered');
      const occluded = coveredByMapLibre || isCoordinateOccludedOnGlobe(map, entry.coordinates);
      entry.element.dataset.occluded = occluded ? 'true' : 'false';
      entry.element.tabIndex = occluded ? -1 : 0;
      entry.element.setAttribute('aria-hidden', occluded ? 'true' : 'false');
    }

    const draftEntry = draftMarkerRef.current;
    if (draftEntry) {
      const coveredByMapLibre = draftEntry.element.classList.contains('maplibregl-marker-covered');
      const occluded =
        coveredByMapLibre || isCoordinateOccludedOnGlobe(map, draftEntry.coordinates);
      draftEntry.element.dataset.occluded = occluded ? 'true' : 'false';
    }
  }, []);

  const executeCameraAction = useCallback(
    (action: PendingCameraAction, animate = true) => {
      const map = mapRef.current;
      if (!map || !styleReadyRef.current) {
        pendingCameraActionRef.current = action;
        return;
      }

      const { width, height, padding } = getCurrentPadding();
      const duration =
        !animate || prefersReducedMotion() ? 0 : 450;

      if (action.type === 'country') {
        const meta = COUNTRY_BY_CODE.get(action.countryCode);
        if (!meta) return;
        overviewRef.current = false;
        // Keep panel insets final while the camera moves, so the layout observer
        // does not interrupt a flight because it sees interpolated padding.
        map.stop();
        map.setPadding(padding);
        activeCameraActionRef.current = action;
        map.flyTo({
          center: normalizeLngLat(meta.center),
          zoom: meta.zoom,
          padding,
          duration,
          essential: true,
        });
        return;
      }

      if (action.type === 'city') {
        if (!isValidLngLat(action.coordinates)) return;
        overviewRef.current = false;
        map.stop();
        map.setPadding(padding);
        activeCameraActionRef.current = action;
        map.flyTo({
          center: normalizeLngLat(action.coordinates),
          zoom: action.zoom ?? CITY_FOCUS_ZOOM,
          padding,
          duration,
          essential: true,
        });
        return;
      }

      if (action.type === 'reset') {
        overviewRef.current = true;
        const zoom = computeInitialGlobeZoom(width, height, padding, INITIAL_GLOBE_CENTER[1]);
        map.stop();
        map.setPadding(padding);
        activeCameraActionRef.current = action;
        map.easeTo({
          center: INITIAL_GLOBE_CENTER,
          zoom,
          bearing: 0,
          pitch: 0,
          padding,
          duration,
          essential: true,
        });
      }
    },
    [getCurrentPadding],
  );

  // App opens the editor and calls the ref in the same event. Wait until React
  // commits its props before calculating the camera's final panel padding.
  const scheduleCameraAction = useCallback((action: PendingCameraAction) => {
    activeCameraActionRef.current = null;
    pendingCameraActionRef.current = action;
    if (cameraFrameRef.current !== null) cancelAnimationFrame(cameraFrameRef.current);
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null;
      if (!mapRef.current || !styleReadyRef.current) return;
      const latest = pendingCameraActionRef.current;
      pendingCameraActionRef.current = null;
      if (latest) executeCameraAction(latest, true);
    });
  }, [executeCameraAction]);

  useImperativeHandle(
    ref,
    () => ({
      flyToCountry(countryCode: string) {
        scheduleCameraAction({ type: 'country', countryCode });
      },
      flyToCity(coordinates: LngLat, zoom = CITY_FOCUS_ZOOM) {
        scheduleCameraAction({ type: 'city', coordinates, zoom });
      },
      resetView() {
        scheduleCameraAction({ type: 'reset' });
      },
    }),
    [scheduleCameraAction],
  );

  const syncCityMarkers = useCallback(
    (nextCities: readonly City[], activeCityId: string | null) => {
      const map = mapRef.current;
      if (!map) return;

      const validCities = deduplicateCities(nextCities);
      const nextIds = new Set(validCities.map((city) => city.id));

      for (const [cityId, entry] of cityMarkersRef.current.entries()) {
        if (!nextIds.has(cityId)) {
          entry.marker.remove();
          cityMarkersRef.current.delete(cityId);
        }
      }

      for (const city of validCities) {
        const normalizedCoords = normalizeLngLat(city.coordinates);
        const isSelected = city.id === activeCityId;
        const existing = cityMarkersRef.current.get(city.id);

        if (existing) {
          existing.coordinates = normalizedCoords;
          existing.marker.setLngLat(normalizedCoords);
          existing.element.dataset.cityName = city.name;
          existing.element.title = city.name;
          existing.element.setAttribute(
            'aria-label',
            `Город ${city.name}: открыть визиты`,
          );
          existing.element.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
          existing.element.classList.toggle('travel-map__marker--selected', isSelected);
          continue;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `travel-map__marker${isSelected ? ' travel-map__marker--selected' : ''}`;
        button.dataset.testid = `city-marker-${city.id}`;
        button.dataset.cityId = city.id;
        button.dataset.cityName = city.name;
        button.title = city.name;
        button.setAttribute(
          'aria-label',
          `Город ${city.name}: открыть визиты`,
        );
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        button.innerHTML = `<span class="travel-map__marker-pin">${FLAG_ICON_SVG}</span>`;

        const handleSelect = (event: Event) => {
          event.stopPropagation();
          if (button.dataset.occluded === 'true') return;
          propsRef.current.onCitySelect(city.id);
        };

        button.addEventListener('click', handleSelect);
        button.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelect(event);
          }
        });

        const marker = new Marker({
          element: button,
          anchor: 'bottom',
          opacity: '1',
          opacityWhenCovered: '0',
        })
          .setLngLat(normalizedCoords)
          .addTo(map);

        cityMarkersRef.current.set(city.id, {
          marker,
          element: button,
          coordinates: normalizedCoords,
        });
      }

      syncMarkersOcclusion();
    },
    [syncMarkersOcclusion],
  );

  const syncDraftMarker = useCallback(
    (nextDraftCoordinates: LngLat | null) => {
      const map = mapRef.current;
      if (!map) return;

      if (!nextDraftCoordinates || !isValidLngLat(nextDraftCoordinates)) {
        if (draftMarkerRef.current) {
          draftMarkerRef.current.marker.remove();
          draftMarkerRef.current = null;
        }
        return;
      }

      const normalizedCoords = normalizeLngLat(nextDraftCoordinates);
      if (draftMarkerRef.current) {
        draftMarkerRef.current.coordinates = normalizedCoords;
        draftMarkerRef.current.marker.setLngLat(normalizedCoords);
        syncMarkersOcclusion();
        return;
      }

      const draftEl = document.createElement('div');
      draftEl.className = 'travel-map__marker travel-map__marker--draft';
      draftEl.dataset.testid = 'draft-city-marker';
      draftEl.setAttribute('aria-hidden', 'true');
      draftEl.innerHTML = `<span class="travel-map__marker-pin">${FLAG_ICON_SVG}</span>`;

      const marker = new Marker({
        element: draftEl,
        anchor: 'bottom',
        opacity: '1',
        opacityWhenCovered: '0',
      })
        .setLngLat(normalizedCoords)
        .addTo(map);

      draftMarkerRef.current = {
        marker,
        element: draftEl,
        coordinates: normalizedCoords,
      };

      syncMarkersOcclusion();
    },
    [syncMarkersOcclusion],
  );

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    styleReadyRef.current = false;
    applyThemeRef.current = null;
    fatalErrorRef.current = false;
    reportStatus({ kind: 'loading' });

    const { width, height, padding } = getCurrentPadding();
    const initialZoom = computeInitialGlobeZoom(width, height, padding, INITIAL_GLOBE_CENTER[1]);

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container,
        style: LIBERTY_STYLE_URL,
        center: INITIAL_GLOBE_CENTER,
        zoom: initialZoom,
        minZoom: -1,
        maxZoom: 18,
        attributionControl: false,
      });
    } catch (error) {
      fatalErrorRef.current = true;
      const classified = classifyMapError({ error }, false);
      reportStatus({
        kind: 'error',
        message:
          classified.message ?? 'Не удалось инициализировать WebGL2 для отображения 3D-карты.',
      });
      return;
    }

    mapRef.current = map;
    if (rootRef.current) {
      (rootRef.current as HTMLDivElement & { __travelMap?: MapLibreMap }).__travelMap = map;
    }

    map.addControl(
      new AttributionControl({
        compact: false,
      }),
      'bottom-right',
    );

    try {
      map.setPadding(padding);
    } catch {
      // Ignore if setPadding is not ready before style initialization
    }

    let gestureMoved = false;
    let pointerDownPoint: { x: number; y: number } | null = null;
    let initializedCamera = false;
    let readyReported = false;

    const checkInitialReadiness = () => {
      if (readyReported || fatalErrorRef.current || !styleReadyRef.current) return;
      if (map.isStyleLoaded() && map.isSourceLoaded(COUNTRIES_SOURCE_ID)) {
        readyReported = true;
        reportStatus({ kind: 'ready' });
      }
    };

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      gestureMoved = false;
      if ('touches' in event) {
        if (event.touches.length > 1) {
          gestureMoved = true;
          pointerDownPoint = null;
          return;
        }
        const touch = event.touches[0];
        pointerDownPoint = touch ? { x: touch.clientX, y: touch.clientY } : null;
      } else {
        pointerDownPoint = { x: event.clientX, y: event.clientY };
      }
    };

    const handlePointerMove = (event: MouseEvent | TouchEvent) => {
      if (!pointerDownPoint) return;
      let clientX = 0;
      let clientY = 0;
      if ('touches' in event) {
        if (event.touches.length > 1) {
          gestureMoved = true;
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        clientX = touch.clientX;
        clientY = touch.clientY;
      } else {
        clientX = event.clientX;
        clientY = event.clientY;
      }
      if (Math.hypot(clientX - pointerDownPoint.x, clientY - pointerDownPoint.y) > 6) {
        gestureMoved = true;
      }
    };

    const markGestureMoved = () => {
      gestureMoved = true;
    };

    const canvasContainer = map.getCanvasContainer();
    canvasContainer.addEventListener('mousedown', handlePointerDown, { passive: true });
    canvasContainer.addEventListener('mousemove', handlePointerMove, { passive: true });
    canvasContainer.addEventListener('touchstart', handlePointerDown, { passive: true });
    canvasContainer.addEventListener('touchmove', handlePointerMove, { passive: true });

    map.on('dragstart', markGestureMoved);
    map.on('rotatestart', markGestureMoved);
    map.on('pitchstart', markGestureMoved);

    const handleStyleLoad = () => {
      if (fatalErrorRef.current) return;
      readyReported = false;
      reportStatus({ kind: 'loading' });
      try {
        map.setProjection(GLOBE_TO_MERCATOR_PROJECTION);
        applyRussianLabelsToStyle(map);
        applyThemeRef.current = createMapThemeController(map);
        applyThemeRef.current(propsRef.current.theme);
        ensureCountrySourceAndLayers(
          map,
          propsRef.current.countryColors,
          propsRef.current.selectedCountryCode,
        );
      } catch {
        fatalErrorRef.current = true;
        reportStatus({ kind: 'error', message: 'Не удалось настроить проекцию и слои карты. Попробуйте загрузить карту снова.' });
        return;
      }

      styleReadyRef.current = true;

      syncCityMarkers(propsRef.current.cities, propsRef.current.selectedCityId);
      syncDraftMarker(propsRef.current.draftCoordinates);
      syncMarkersOcclusion();

      if (pendingCameraActionRef.current) {
        const pending = pendingCameraActionRef.current;
        pendingCameraActionRef.current = null;
        executeCameraAction(pending, false);
      } else if (!initializedCamera) {
        const currentMetrics = getCurrentPadding();
        const targetZoom = computeInitialGlobeZoom(
          currentMetrics.width,
          currentMetrics.height,
          currentMetrics.padding,
          INITIAL_GLOBE_CENTER[1],
        );
        map.jumpTo({
          center: INITIAL_GLOBE_CENTER,
          zoom: targetZoom,
          bearing: 0,
          pitch: 0,
          padding: currentMetrics.padding,
        });
        overviewRef.current = true;
      }
      initializedCamera = true;
      checkInitialReadiness();
    };

    const handleSourceData = (event: MapSourceDataEvent) => {
      if (event.sourceId === COUNTRIES_SOURCE_ID && event.isSourceLoaded) {
        syncMarkersOcclusion();
      }
      checkInitialReadiness();
    };

    const handleMapError = (event: MapLibreErrorEvent & { sourceId?: string; tile?: unknown }) => {
      const classified = classifyMapError(event, styleReadyRef.current);
      if (!classified.fatal) return;

      fatalErrorRef.current = true;
      reportStatus({
        kind: 'error',
        message: classified.message ?? 'Не удалось загрузить карту.',
      });
    };

    const handleContextLost = () => {
      fatalErrorRef.current = true;
      reportStatus({ kind: 'error', message: 'Графический контекст карты потерян. Нажмите «Повторить», чтобы восстановить карту.' });
    };
    const handleUserZoom = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) {
        overviewRef.current = false;
        activeCameraActionRef.current = null;
      }
    };
    const finishCameraAction = () => { activeCameraActionRef.current = null; };

    const queryCountryAtPoint = (point: { x: number; y: number }): string | null => {
      if (!styleReadyRef.current || !map.getLayer(COUNTRIES_HIT_LAYER_ID)) {
        return null;
      }
      const exactFeatures = map.queryRenderedFeatures([point.x, point.y], {
        layers: [COUNTRIES_HIT_LAYER_ID],
      });
      const exactCode = extractCountryCodeFromFeatures(exactFeatures);
      if (exactCode) return exactCode;

      const toleranceFeatures = map.queryRenderedFeatures(
        [
          [point.x - 3, point.y - 3],
          [point.x + 3, point.y + 3],
        ],
        { layers: [COUNTRIES_HIT_LAYER_ID] },
      );
      return extractCountryCodeFromFeatures(toleranceFeatures);
    };

    const handleMapClick = (event: MapLayerMouseEvent) => {
      if (gestureMoved || fatalErrorRef.current || !styleReadyRef.current) {
        gestureMoved = false;
        return;
      }

      const target = event.originalEvent?.target;
      if (
        target instanceof Element &&
        (target.closest('.travel-map__marker') ||
          target.closest('.travel-map__controls') ||
          target.closest('.maplibregl-ctrl'))
      ) {
        return;
      }

      const surfacePoint = resolveVisibleSurfacePoint(map, event.point, {
        width: container.clientWidth,
        height: container.clientHeight,
      });
      if (!surfacePoint) {
        return;
      }

      if (propsRef.current.mode === 'countries') {
        const countryCode = queryCountryAtPoint(event.point);
        if (countryCode) {
          propsRef.current.onCountrySelect(countryCode);
        }
        return;
      }

      if (propsRef.current.mode === 'flags') {
        propsRef.current.onMapPointSelect(surfacePoint);
      }
    };

    const handleMouseMove = (event: MapLayerMouseEvent) => {
      if (gestureMoved || !styleReadyRef.current) return;
      const canvas = map.getCanvas();
      const surfacePoint = resolveVisibleSurfacePoint(map, event.point, {
        width: container.clientWidth,
        height: container.clientHeight,
      });
      if (!surfacePoint) {
        canvas.style.cursor = '';
        return;
      }

      if (propsRef.current.mode === 'flags') {
        canvas.style.cursor = 'crosshair';
        return;
      }

      const countryCode = queryCountryAtPoint(event.point);
      canvas.style.cursor = countryCode ? 'pointer' : '';
    };

    map.on('style.load', handleStyleLoad);
    map.on('sourcedata', handleSourceData);
    map.on('error', handleMapError);
    map.on('webglcontextlost', handleContextLost);
    map.on('zoomstart', handleUserZoom);
    map.on('movestart', handleUserZoom);
    map.on('moveend', finishCameraAction);
    map.on('click', handleMapClick);
    map.on('mousemove', handleMouseMove);
    map.on('move', syncMarkersOcclusion);
    map.on('moveend', syncMarkersOcclusion);
    map.on('zoom', syncMarkersOcclusion);
    map.on('rotate', syncMarkersOcclusion);
    map.on('pitch', syncMarkersOcclusion);
    map.on('idle', syncMarkersOcclusion);
    map.on('idle', checkInitialReadiness);

    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame: number | null = null;
    let previousWidth = container.clientWidth;
    let previousHeight = container.clientHeight;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeFrame !== null) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          if (mapRef.current !== map || fatalErrorRef.current) return;
          if (container.clientWidth === previousWidth && container.clientHeight === previousHeight) return;
          previousWidth = container.clientWidth;
          previousHeight = container.clientHeight;
          const metrics = getCurrentPadding();
          const center = map.getCenter();
          const interruptedAction = map.isMoving() ? activeCameraActionRef.current : null;
          map.stop();
          map.resize();
          if (interruptedAction) {
            executeCameraAction(interruptedAction);
            return;
          }
          map.jumpTo({
            padding: metrics.padding,
            ...(overviewRef.current ? { zoom: computeInitialGlobeZoom(metrics.width, metrics.height, metrics.padding, center.lat) } : {}),
          });
          syncMarkersOcclusion();
        });
      });
      resizeObserver.observe(container);
    }

    const stopObservingPanels = observeUiPanels(() => {
      if (mapRef.current !== map || fatalErrorRef.current || !styleReadyRef.current) return;
      if (cameraFrameRef.current !== null) return;
      const metrics = getCurrentPadding();
      try {
        const previous = map.getPadding();
        const changed = Object.keys(metrics.padding).some(
          (key) =>
            previous[key as keyof typeof previous] !==
            metrics.padding[key as keyof typeof metrics.padding],
        );
        if (changed) {
          // A country can be marked before its flight ends. That grows the
          // mobile sheet; continue to the intended place with its new insets.
          const interruptedAction = map.isMoving() ? activeCameraActionRef.current : null;
          map.stop();
          if (interruptedAction) {
            executeCameraAction(interruptedAction);
            return;
          }
          if (overviewRef.current) {
            const center = map.getCenter();
            map.jumpTo({
              padding: metrics.padding,
              zoom: computeInitialGlobeZoom(
                metrics.width,
                metrics.height,
                metrics.padding,
                center.lat,
              ),
            });
          } else {
            map.setPadding(metrics.padding);
          }
          syncMarkersOcclusion();
        }
      } catch {
        // Ignore transient padding update errors
      }
    });

    return () => {
      if (cameraFrameRef.current !== null) {
        cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }
      stopObservingPanels();
      activeCameraActionRef.current = null;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      canvasContainer.removeEventListener('mousedown', handlePointerDown);
      canvasContainer.removeEventListener('mousemove', handlePointerMove);
      canvasContainer.removeEventListener('touchstart', handlePointerDown);
      canvasContainer.removeEventListener('touchmove', handlePointerMove);

      for (const entry of cityMarkersRef.current.values()) {
        entry.marker.remove();
      }
      cityMarkersRef.current.clear();

      if (draftMarkerRef.current) {
        draftMarkerRef.current.marker.remove();
        draftMarkerRef.current = null;
      }

      styleReadyRef.current = false;
      applyThemeRef.current = null;
      mapRef.current = null;
      if (rootRef.current) {
        delete (rootRef.current as HTMLDivElement & { __travelMap?: MapLibreMap }).__travelMap;
      }
      map.remove();
    };
  }, [
    executeCameraAction,
    getCurrentPadding,
    reportStatus,
    retryCount,
    syncCityMarkers,
    syncDraftMarker,
    syncMarkersOcclusion,
  ]);

  useEffect(() => {
    applyThemeRef.current?.(theme);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncCountryColorsPaint(map, countryColors);
  }, [countryColors]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncSelectedCountryPaint(map, selectedCountryCode);
  }, [selectedCountryCode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncCityMarkers(cities, selectedCityId);
  }, [cities, selectedCityId, syncCityMarkers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncDraftMarker(draftCoordinates);
  }, [draftCoordinates, syncDraftMarker]);

  useEffect(() => {
    const map = mapRef.current;
    if (
      selectedCountryCode === null &&
      selectedCityId === null &&
      draftCoordinates === null &&
      pendingCameraActionRef.current?.type !== 'reset'
    ) {
      if (cameraFrameRef.current !== null) {
        cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }
      pendingCameraActionRef.current = null;
      activeCameraActionRef.current = null;
    }
    if (!map || !styleReadyRef.current) return;
    const { padding } = getCurrentPadding();
    try {
      const previous = map.getPadding();
      if (Object.keys(padding).some(key => previous[key as keyof typeof previous] !== padding[key as keyof typeof padding])) {
        // Closing a panel mid-flight must not let the animation restore stale padding.
        map.stop();
        map.setPadding(padding);
      }
      syncMarkersOcclusion();
    } catch {
      // Ignore transient padding update errors
    }
  }, [selectedCountryCode, selectedCityId, draftCoordinates, getCurrentPadding, syncMarkersOcclusion]);

  const handleZoomIn = () => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    overviewRef.current = false;
    activeCameraActionRef.current = null;
    map.zoomIn({ duration: prefersReducedMotion() ? 0 : 260 });
  };

  const handleZoomOut = () => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    overviewRef.current = false;
    activeCameraActionRef.current = null;
    map.zoomOut({ duration: prefersReducedMotion() ? 0 : 260 });
  };

  const handleResetView = () => {
    executeCameraAction({ type: 'reset' }, true);
  };

  const handleRetry = () => {
    setRetryCount((prev) => prev + 1);
  };

  return (
    <div
      ref={rootRef}
      className="travel-map"
      data-testid="travel-map"
      data-map-mode={mode}
      data-map-status={status.kind}
      data-selected-country={selectedCountryCode ?? ''}
      data-selected-city={selectedCityId ?? ''}
    >
      <div
        ref={canvasContainerRef}
        className="travel-map__canvas"
        data-testid="travel-map-canvas"
      />

      <div className="travel-map__controls" role="group" aria-label="Управление видом карты">
        <button
          type="button"
          className="travel-map__control-btn"
          onClick={handleZoomIn}
          disabled={status.kind !== 'ready'}
          aria-label="Увеличить масштаб карты"
          title="Увеличить масштаб"
        >
          <Plus size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="travel-map__control-btn"
          onClick={handleZoomOut}
          disabled={status.kind !== 'ready'}
          aria-label="Уменьшить масштаб карты"
          title="Уменьшить масштаб"
        >
          <Minus size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="travel-map__control-btn"
          onClick={handleResetView}
          disabled={status.kind !== 'ready'}
          aria-label="Сбросить вид карты к глобусу"
          title="Сбросить вид к глобусу"
        >
          <Globe2 size={17} aria-hidden="true" />
        </button>
      </div>

      {status.kind === 'loading' ? (
        <div className="travel-map__status-pill" role="status" aria-live="polite">
          Загрузка 3D-карты…
        </div>
      ) : null}

      {status.kind === 'error' ? (
        <div className="travel-map__error-overlay" role="alert">
          <div className="travel-map__error-card">
            <h2 className="travel-map__error-title">Не удалось отобразить карту</h2>
            <p className="travel-map__error-text">
              {status.message ||
                'Произошла ошибка при загрузке карты. Проверьте подключение и попробуйте снова.'}
            </p>
            <div className="travel-map__error-actions">
              <button
                type="button"
                className="primary"
                onClick={handleRetry}
                data-testid="map-retry-button"
              >
                Повторить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default TravelMap;
