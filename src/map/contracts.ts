import type { City, InteractionMode, LngLat } from '../domain/types';

export interface TravelMapProps {
  mode: InteractionMode;
  countryColors: Readonly<Record<string, string>>;
  cities: readonly City[];
  selectedCountryCode: string | null;
  selectedCityId: string | null;
  draftCoordinates: LngLat | null;
  onCountrySelect: (code: string) => void;
  onMapPointSelect: (coordinates: LngLat) => void;
  onCitySelect: (id: string) => void;
  onStatusChange?: (status: MapStatus) => void;
}

export type MapStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface TravelMapHandle {
  flyToCountry: (code: string) => void;
  flyToCity: (coordinates: LngLat) => void;
  resetView: () => void;
}
