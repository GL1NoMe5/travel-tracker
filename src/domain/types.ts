/** Coordinates are always [longitude, latitude], in degrees. */
export type LngLat = [number, number];
export type InteractionMode = 'countries' | 'flags';

export interface Visit {
  id: string;
  /** Calendar date, not a UTC timestamp. */
  date: string | null;
  note: string;
}

export interface City {
  id: string;
  name: string;
  coordinates: LngLat;
  countryCode?: string;
  /** Original locality/admin context is independent of the editable name. */
  localityName?: string;
  regionName?: string;
  osmRefs: string[];
  visits: Visit[];
}

export interface PlaceCandidate {
  name: string;
  coordinates: LngLat;
  countryCode?: string;
  localityName?: string;
  regionName?: string;
  osmRef?: string;
  displayName: string;
}

export interface TrackerData {
  schemaVersion: 1;
  countryColors: Record<string, string>;
  /** Missing in older v1 snapshots; each marked country then means one visit. */
  countryVisits?: Record<string, number>;
  cities: City[];
}

export interface Country {
  code: string;
  name: string;
  center: LngLat;
  zoom: number;
}
