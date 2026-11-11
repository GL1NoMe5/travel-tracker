import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Check,
  Flag,
  Heart,
  ArrowUpRight,
  BookOpen,
  LocateFixed,
  ArrowRight,
  MapPin,
  Plus,
  Search,
  Moon,
  Sun,
  X,
} from 'lucide-react';
import { COUNTRIES, COUNTRY_BY_CODE } from './data/countries';
import {
  createCity,
  findCityMatch,
  formatCalendarDate,
  getStats,
  getCountryVisitCount,
  MAX_NOTE_LENGTH,
  type TrackerAction,
  latestVisitDate,
} from './domain/tracker';
import type { City, InteractionMode, LngLat, PlaceCandidate, PlaceStatus } from './domain/types';
import { createGeocoder } from './services/geocoder';
import { useTracker } from './storage/useTracker';
import TravelMap from './map/TravelMap';
import type { TravelMapHandle } from './map/contracts';
import { CityEditor } from './components/CityEditor';
import { CountryEditor } from './components/CountryEditor';
import { PlaceStatusSwitch } from './components/PlaceStatusSwitch';
import { useViewportLayout } from './hooks/ui/useViewportLayout';
import { useFocusRestore } from './hooks/ui/useFocusRestore';
import { useTheme } from './hooks/ui/useTheme';
import { useMarkerColors } from './hooks/ui/useMarkerColors';

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось выполнить действие.';

export default function App() {
  const tracker = useTracker();
  const { data, blocked } = tracker;
  const stats = getStats(data);
  const { theme, toggleTheme } = useTheme();
  const { markerColors, setMarkerColor, resetMarkerColors } = useMarkerColors();
  const geocoder = useMemo(() => createGeocoder(), []);
  const mapRef = useRef<TravelMapHandle>(null);

  const { isMobile } = useViewportLayout();
  const editorFocus = useFocusRestore();

  const [mode, setMode] = useState<InteractionMode>('countries');
  const [tab, setTab] = useState<'countries' | 'cities' | 'wishlist'>('countries');
  const [searchIntent, setSearchIntent] = useState<PlaceStatus>('visited');
  const [panel, setPanel] = useState<'search' | 'collection' | null>(null);
  const [toast, setToast] = useState('');
  const [introDismissed, setIntroDismissed] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');
  const [reverseStatus, setReverseStatus] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraftState] = useState<City | null>(null);
  const draftRef = useRef<City | null>(null);
  const draftOriginal = useRef('');
  const [matches, setMatches] = useState<{ candidate: PlaceCandidate; cities: City[] } | null>(null);
  const [distinctCityConfirmed, setDistinctCityConfirmed] = useState(false);
  const [pendingWrite, setPendingWrite] = useState<'save' | 'delete' | 'country' | null>(null);
  const pendingWriteRef = useRef<typeof pendingWrite>(null);

  const countriesTabRef = useRef<HTMLButtonElement>(null);
  const citiesTabRef = useRef<HTMLButtonElement>(null);
  const wishlistTabRef = useRef<HTMLButtonElement>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const reverseAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      reverseAbort.current?.abort();
    },
    [],
  );

  function setDraft(city: City | null) {
    draftRef.current = city;
    setDraftState(city);
  }

  function editDraft(city: City) {
    if (pendingWriteRef.current) return;
    if (
      draftRef.current &&
      city.coordinates.some((value, index) => value !== draftRef.current!.coordinates[index])
    ) {
      reverseAbort.current?.abort();
      setReverseStatus('');
    }
    setDraft(city);
  }

  function startDraft(city: City | null) {
    const detached = city ? structuredClone(city) : null;
    draftOriginal.current = JSON.stringify(detached);
    setDraft(detached);
    setMatches(null);
    setDistinctCityConfirmed(false);
    setError('');
  }

  function canLeaveDraft(): boolean {
    if (pendingWriteRef.current) return false;
    return (
      !draftRef.current ||
      JSON.stringify(draftRef.current) === draftOriginal.current ||
      window.confirm('Закрыть без сохранения изменений?')
    );
  }

  const closeDraft = useCallback(() => {
    if (!canLeaveDraft()) return;
    reverseAbort.current?.abort();
    setReverseStatus('');
    startDraft(null);
    setMode('countries');
    editorFocus.restoreFocus('[data-focus-id="add-place"]');
  }, [editorFocus]);

  const closeCountryEditor = useCallback(() => {
    if (pendingWriteRef.current) return;
    setCountryCode(null);
    editorFocus.restoreFocus('[data-focus-id="add-place"]');
  }, [editorFocus]);

  function openCity(id: string, openerSelector?: string) {
    if (!canLeaveDraft()) return;
    const city = data.cities.find((item) => item.id === id);
    if (!city) return;
    editorFocus.recordOpener(openerSelector ?? `[data-city-list-id="${CSS.escape(id)}"]`);
    reverseAbort.current?.abort();
    setReverseStatus('');
    setPanel(null);
    setCountryCode(null);
    startDraft(city);
    mapRef.current?.flyToCity(city.coordinates);
  }

  function selectCountry(code: string, fly = false, openerSelector?: string) {
    if (!COUNTRY_BY_CODE.has(code) || !canLeaveDraft()) return;
    setIntroDismissed(true);
    editorFocus.recordOpener(openerSelector ?? `[data-country-code="${CSS.escape(code)}"]`);
    reverseAbort.current?.abort();
    setReverseStatus('');
    startDraft(null);
    setPanel(null);
    setCountryCode(code);
    if (fly) mapRef.current?.flyToCountry(code);
  }

  function acceptCandidate(candidate: PlaceCandidate) {
    if (blocked || !canLeaveDraft()) return;
    setIntroDismissed(true);
    editorFocus.recordOpener('[data-focus-id="add-place"]');
    reverseAbort.current?.abort();
    setReverseStatus('');
    setCountryCode(null);
    setPanel(null);
    setResults([]);
    const match = findCityMatch(data.cities, candidate);
    if (match.exact) startDraft(match.exact);
    else {
      startDraft(createCity(candidate, searchIntent));
      if (match.suggestions.length) setMatches({ candidate, cities: match.suggestions });
    }
    mapRef.current?.flyToCity(match.exact?.coordinates ?? candidate.coordinates);
  }

  async function onMapPointSelect(coordinates: LngLat) {
    if (blocked || !canLeaveDraft()) return;
    setIntroDismissed(true);
    editorFocus.recordOpener('[data-testid="travel-map"] canvas');
    reverseAbort.current?.abort();
    const controller = new AbortController();
    reverseAbort.current = controller;
    setPanel(null);
    setCountryCode(null);
    const pending = createCity({ name: '', displayName: '', coordinates }, searchIntent);
    startDraft(pending);
    setReverseStatus('Определяем город… Название можно ввести вручную.');
    try {
      const candidate = await geocoder.reverseGeocode(coordinates, controller.signal);
      if (
        controller.signal.aborted ||
        draftRef.current?.id !== pending.id ||
        draftRef.current.coordinates.some((value, index) => value !== coordinates[index])
      ) {
        return;
      }
      const current = draftRef.current;
      const match = findCityMatch(data.cities, candidate);
      const pristine = JSON.stringify(current) === draftOriginal.current;
      if (match.exact && pristine) startDraft(match.exact);
      else {
        const resolved = {
          ...current,
          name: current.name.trim() ? current.name : candidate.name,
          countryCode: candidate.countryCode,
          localityName: candidate.localityName,
          regionName: candidate.regionName,
          osmRefs: candidate.osmRef ? [candidate.osmRef] : [],
        };
        setDraft(resolved);
        if (pristine) draftOriginal.current = JSON.stringify(resolved);
        const suggestions = match.exact ? [match.exact] : match.suggestions;
        if (suggestions.length) setMatches({ candidate, cities: suggestions });
      }
      setReverseStatus('');
    } catch (err) {
      if (!controller.signal.aborted && draftRef.current?.id === pending.id) {
        setReverseStatus(`${messageOf(err)} Введите название вручную.`);
      }
    }
  }

  function useExistingCity(city: City) {
    if (pendingWriteRef.current) return;
    if (!draft || !matches) return;
    // A future plan must never manufacture a past visit or erase its history.
    if (draft.status === 'wishlist' && city.status !== 'wishlist') {
      openCity(city.id);
      return;
    }
    const refs = new Set([...city.osmRefs, ...draft.osmRefs]);
    if (matches.candidate.osmRef) refs.add(matches.candidate.osmRef);
    const combined: City = {
      ...structuredClone(city),
      osmRefs: [...refs],
      visits: [...city.visits, ...draft.visits],
    };
    const joinNotes = (a = '', b = '') => a === b ? a : [a, b].filter(Boolean).join('\n\n');
    if (city.status === 'wishlist' && draft.status === 'wishlist') {
      combined.wishNote = joinNotes(city.wishNote, draft.wishNote);
    } else if (city.status === 'wishlist') {
      combined.status = 'visited';
      delete combined.wishNote;
      combined.visits = draft.visits.map((visit, index) => index === 0 ? { ...visit, note: joinNotes(city.wishNote, visit.note) } : visit);
    }
    if ((combined.wishNote?.length ?? 0) > MAX_NOTE_LENGTH || combined.visits.some(visit => visit.note.length > MAX_NOTE_LENGTH)) {
      setError(`После объединения заметка длиннее ${MAX_NOTE_LENGTH} символов. Сократите заметку перед объединением.`);
      return;
    }
    startDraft(combined);
    // New visits are unsaved edits, even though the original city already exists.
    draftOriginal.current = JSON.stringify(city);
    mapRef.current?.flyToCity(city.coordinates);
  }

  function beginWrite(kind: NonNullable<typeof pendingWrite>): boolean {
    if (pendingWriteRef.current) return false;
    pendingWriteRef.current = kind;
    setPendingWrite(kind);
    return true;
  }

  function finishWrite() {
    pendingWriteRef.current = null;
    setPendingWrite(null);
  }

  async function saveCountry(action: TrackerAction) {
    if (blocked || !beginWrite('country')) return;
    try { await tracker.commit(action); }
    catch (err) { setError(messageOf(err)); }
    finally { finishWrite(); }
  }

  async function saveDraft() {
    if (!draft || pendingWriteRef.current) return;
    if (matches) {
      setError('Это место уже есть в вашей коллекции. Выберите его или сохраните отдельное.');
      return;
    }
    if (!data.cities.some((city) => city.id === draft.id) && !distinctCityConfirmed) {
      const candidate: PlaceCandidate = {
        name: draft.name,
        displayName: draft.name,
        coordinates: draft.coordinates,
        countryCode: draft.countryCode,
        localityName: draft.localityName,
        regionName: draft.regionName,
        osmRef: draft.osmRefs[0],
      };
      const match = findCityMatch(data.cities, candidate);
      const suggestions = match.exact ? [match.exact] : match.suggestions;
      if (suggestions.length) {
        setMatches({ candidate, cities: suggestions });
        return;
      }
    }
    if (!beginWrite('save')) return;
    reverseAbort.current?.abort();
    setReverseStatus('');
    try {
      const savedId = draft.id;
      if (await tracker.commit({ type: 'saveCity', city: draft })) {
        reverseAbort.current?.abort();
        setReverseStatus('');
        startDraft(null);
        setTab(draft.status === 'wishlist' ? 'wishlist' : 'cities');
        setMode('countries');
        setToast(draft.status === 'wishlist' ? 'Добавлено в желания' : 'Место сохранено');
        editorFocus.recordOpener(`[data-city-list-id="${CSS.escape(savedId)}"]`);
        editorFocus.restoreFocus('[data-focus-id="add-place"]');
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      finishWrite();
    }
  }

  async function deleteDraft() {
    if (!draft || !beginWrite('delete')) return;
    reverseAbort.current?.abort();
    setReverseStatus('');
    try {
      if (
        !data.cities.some((city) => city.id === draft.id) ||
        (await tracker.commit({ type: 'deleteCity', id: draft.id }))
      ) {
        startDraft(null);
        setMode('countries');
        editorFocus.restoreFocus('[data-focus-id="add-place"]');
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      finishWrite();
    }
  }

  async function searchCities() {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    setSearchStatus('');
    setResults([]);
    try {
      const found = await (searchIntent === 'wishlist' ? geocoder.searchPlaces(query, controller.signal) : geocoder.searchCities(query, controller.signal));
      if (!controller.signal.aborted) {
        setResults(found);
        if (!found.length) setSearchStatus('Ничего не найдено. Уточните название и ближайший город.');
      }
    } catch (err) {
      if (!controller.signal.aborted) setSearchStatus(messageOf(err));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const tabs = ['countries', 'cities', 'wishlist'] as const;
    const refs = [countriesTabRef, citiesTabRef, wishlistTabRef];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2
      : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    refs[next].current?.focus();
  }

  const validDraftCoordinates =
    draft &&
    draft.coordinates.every(Number.isFinite) &&
    Math.abs(draft.coordinates[0]) <= 180 &&
    Math.abs(draft.coordinates[1]) <= 90
      ? draft.coordinates
      : null;

  const country = countryCode ? COUNTRY_BY_CODE.get(countryCode) : undefined;
  const renderEditorContent = () => {
    if (country) {
      return (
        <CountryEditor
          countryCode={country.code}
          countryName={country.name}
          currentColor={data.countryColors[country.code]}
          visitCount={getCountryVisitCount(data, country.code)}
          disabled={blocked || pendingWrite !== null}
          onSelectColor={(color) => {
            void saveCountry({ type: 'colorCountry', code: country.code, color });
          }}
          onResetColor={() => {
            void saveCountry({ type: 'resetCountry', code: country.code });
          }}
          onSetVisitCount={count => { void saveCountry({ type: 'setCountryVisits', code: country.code, count }); }}
          onClose={closeCountryEditor}
        />
      );
    }

    if (draft) {
      return (
        <div className="editor-stack">
          {matches ? (
            <section className="match-panel" aria-label="Возможное совпадение города">
              <h2>Это место уже есть?</h2>
              {matches.cities.map((city) => (
                <button
                  type="button"
                  className="secondary wide"
                  key={city.id}
                  onClick={() => useExistingCity(city)}
                >
                  {draft.status === 'wishlist' && city.status !== 'wishlist' ? 'Открыть посещённое место: ' : 'Объединить с местом: '}{city.name}
                  {city.regionName ? ` · ${city.regionName}` : ''}
                </button>
              ))}
              <button
                type="button"
                className="secondary wide"
                onClick={() => {
                  setDraft({
                    ...draft,
                    osmRefs: draft.osmRefs.filter(
                      (ref) => !data.cities.some((city) => city.osmRefs.includes(ref)),
                    ),
                  });
                  setDistinctCityConfirmed(true);
                  setMatches(null);
                }}
              >
                Это другое место
              </button>
            </section>
          ) : null}
          <CityEditor
            city={draft}
            existing={data.cities.some((city) => city.id === draft.id)}
            disabled={blocked || pendingWrite !== null}
            pendingAction={pendingWrite === 'save' || pendingWrite === 'delete' ? pendingWrite : null}
            onChange={editDraft}
            onSave={() => {
              void saveDraft();
            }}
            onClose={closeDraft}
            onDelete={() => {
              void deleteDraft();
            }}
          />
        </div>
      );
    }

    return null;
  };


  const listedCountries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru');
    return normalized ? COUNTRIES.filter(item => item.name.toLocaleLowerCase('ru').includes(normalized)).slice(0, 12) : [];
  }, [query]);
  const savedCountries = COUNTRIES.filter(item => data.countryColors[item.code]);
  const sortedPlaces = useMemo(() => [...data.cities].sort((a, b) => a.name.localeCompare(b.name, 'ru')), [data.cities]);
  const sortedCities = sortedPlaces.filter(city => city.status !== 'wishlist');
  const sortedWishes = sortedPlaces.filter(city => city.status === 'wishlist');
  const activePanel = country ? 'country' : draft ? 'city' : panel;
  const hasPlaces = stats.countries + stats.cities + stats.wishlist > 0;

  function openPanel(next: 'search' | 'collection', intent: PlaceStatus = 'visited', collectionTab?: typeof tab) {
    if (!canLeaveDraft()) return;
    editorFocus.recordOpener(collectionTab === 'wishlist' || intent === 'wishlist' ? '[data-focus-id="wishlist"]'
      : next === 'search' ? '[data-focus-id="add-place"]' : '[data-focus-id="my-places"]');
    if (next === 'search') {
      searchAbort.current?.abort();
      setSearching(false); setQuery(''); setResults([]); setSearchStatus('');
      setSearchIntent(intent);
    }
    if (collectionTab) setTab(collectionTab);
    reverseAbort.current?.abort();
    setReverseStatus('');
    startDraft(null);
    setCountryCode(null);
    setMode('countries');
    setPanel(next);
    setError('');
  }

  const closePanel = useCallback(() => {
    if (!canLeaveDraft()) return;
    searchAbort.current?.abort();
    setSearching(false);
    setPanel(null);
    editorFocus.restoreFocus('[data-focus-id="add-place"]');
  }, [editorFocus]);

  useEffect(() => {
    if (panel === 'search' && !country && !draft) searchInput.current?.focus();
  }, [panel, country, draft]);

  useEffect(() => {
    if (!panel || country || draft) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [panel, country, draft, closePanel]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function chooseOnMap() {
    searchAbort.current?.abort();
    setSearching(false);
    setPanel(null);
    setMode('flags');
    requestAnimationFrame(() => document.querySelector<HTMLCanvasElement>('.maplibregl-canvas')?.focus());
  }

  const countryRow = (item: typeof COUNTRIES[number]) => (
    <li key={item.code}>
      <button type="button" aria-label={item.name} data-country-code={item.code}
        disabled={pendingWrite !== null} onClick={() => selectCountry(item.code, true)}>
        <span className="country-dot" style={{ background: data.countryColors[item.code] ?? 'var(--line)' }} aria-hidden="true">
          {data.countryColors[item.code] ? <Check size={12} /> : null}
        </span>
        <span className="place-name">{item.name}{data.countryColors[item.code] ? <small>{getCountryVisitCount(data, item.code)} {plural(getCountryVisitCount(data, item.code), 'посещение', 'посещения', 'посещений')}</small> : null}</span>
        <ArrowUpRight size={16} className="row-arrow" aria-hidden="true" />
      </button>
    </li>
  );

  const wishlistEntry = <button type="button" className="wishlist-entry" data-focus-id="wishlist"
    aria-label="Хочу посетить" aria-controls="travel-panel" disabled={pendingWrite !== null}
    onClick={() => openPanel('collection', 'wishlist', 'wishlist')}>
    <Heart size={18} aria-hidden="true" /><span>Хочу посетить</span>
    {!isMobile ? <span className="wishlist-count">{stats.wishlist}</span> : null}
  </button>;

  return (
    <main className="app" data-panel-open={Boolean(activePanel)}>
      <div className="map-stage">
        <TravelMap ref={mapRef} theme={theme} markerColors={markerColors} mode={mode} countryColors={data.countryColors} cities={data.cities}
          selectedCountryCode={countryCode} selectedCityId={draft?.id ?? null}
          draftCoordinates={draft && !data.cities.some(city => city.id === draft.id) ? validDraftCoordinates : null}
          draftStatus={draft?.status ?? 'visited'}
          onCountrySelect={code => selectCountry(code, false, '[data-testid="travel-map"] canvas')}
          onMapPointSelect={coordinates => { void onMapPointSelect(coordinates); }}
          onCitySelect={id => openCity(id, `[data-testid="city-marker-${CSS.escape(id)}"]`)} />
      </div>

      <header className="topbar" data-ui-panel="topbar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
            <path d="M8 25c0-8 20-3 20-14M8 25l-4-4m4 4 5-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="28" cy="9" r="4" stroke="currentColor" strokeWidth="2" />
          </svg>
          <h1>Карта<br className="mobile-break" /> путешествий</h1>
        </div>
        <nav className="header-actions" aria-label="Путешествия">
          <button type="button" className="icon-button theme-toggle" onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
            {theme === 'dark' ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
          </button>
          <button type="button" className="collection-button" data-focus-id="my-places"
            aria-label="Мои места" aria-expanded={panel === 'collection'} aria-controls="travel-panel"
            disabled={pendingWrite !== null} onClick={() => panel === 'collection' ? closePanel() : openPanel('collection')}>
            <BookOpen size={18} aria-hidden="true" /><span>Мои места</span>
            {hasPlaces ? <span className="collection-count">{stats.countries + stats.cities + stats.wishlist}</span> : null}
          </button>
          {!isMobile ? <button type="button" className="primary add-place" data-focus-id="add-place"
            disabled={blocked || pendingWrite !== null} onClick={() => openPanel('search')}>
            <Plus size={18} aria-hidden="true" />Добавить место
          </button> : null}
        </nav>
      </header>

      {!activePanel && mode === 'countries' ? <>
        {isMobile && !hasPlaces && !introDismissed ? <section className="map-intro">
          <h2>Здесь живут <br />ваши путешествия</h2>
          <p>{'Отметьте страну, в которой были.\nСохраните место, которое хочется помнить.'}</p>
          {!isMobile ? <button className="intro-link" type="button" disabled={blocked} onClick={() => openPanel('search')}>
            {hasPlaces ? 'Куда ещё вы ездили?' : 'Начать с первого места'}<ArrowRight size={18} aria-hidden="true" />
          </button> : null}
        </section> : null}
        {!isMobile ? <section className="journey-overview" aria-label="Обзор путешествий" data-ui-panel="sidebar">
          <h2>Мои путешествия</h2>
          <p className="hint">{hasPlaces ? 'Страны, в которые хочется возвращаться.' : 'Ваша история начинается с первой отметки.'}</p>
          <dl className="overview-stats">
            <div><dt>Страны</dt><dd>{stats.countries} <small>из 195</small></dd></div>
            <div><dt>Места</dt><dd>{stats.cities}</dd></div>
            <div><dt>Поездки в страны</dt><dd>{stats.countryVisits}</dd></div>
          </dl>
          <progress className="overview-progress" max={195} value={stats.countries} aria-label="Посещено стран" />
          {wishlistEntry}
          {savedCountries.length ? <><h3>Ваши страны</h3><ul className="place-list overview-list">
            {[...savedCountries].sort((a, b) => getCountryVisitCount(data, b.code) - getCountryVisitCount(data, a.code)).slice(0, 3).map(countryRow)}
          </ul><button className="text-button" type="button" onClick={() => openPanel('collection')}>Все мои места<ArrowRight size={18} aria-hidden="true" /></button></> :
          <button className="text-button" type="button" disabled={blocked} onClick={() => openPanel('search')}>Добавить первую страну<ArrowRight size={18} aria-hidden="true" /></button>}
          <p className="local-save-note">Сохраняется в этом браузере</p>
        </section> : null}
      </> : null}

      {mode === 'flags' && !draft ? <div className="point-instruction" role="status">
        {searchIntent === 'wishlist' ? <Heart size={18} className="wish-icon" aria-hidden="true" /> : <MapPin size={18} aria-hidden="true" />}<span>{searchIntent === 'wishlist' ? 'Выберите место, куда хотите поехать' : 'Нажмите на место на карте'}</span>
        <button type="button" className="text-button" onClick={() => setMode('countries')}>Отмена</button>
      </div> : null}

      {activePanel ? <aside id="travel-panel" className={`context-panel context-panel--${activePanel}`}
        data-ui-panel={isMobile ? 'sheet' : 'editor'} data-sheet-state={activePanel}
        aria-label={activePanel === 'search' ? 'Добавить место' : activePanel === 'collection' ? 'Мои места' : 'Выбранное место'}>
        <div className="sheet-handle" aria-hidden="true" />
        {country || draft ? renderEditorContent() : <>
          <header className="section-heading panel-heading">
            <h2 className="editor-heading">{panel === 'search' ? searchIntent === 'wishlist' ? 'Куда хочется поехать?' : 'Куда вы ездили?' : 'Мои места'}</h2>
            <button type="button" className="icon-button" aria-label="Закрыть панель" onClick={closePanel}><X size={20} aria-hidden="true" /></button>
          </header>
          {panel === 'search' ? <div className="search-panel-content">
            <PlaceStatusSwitch value={searchIntent} onChange={intent => {
              searchAbort.current?.abort(); setSearching(false); setResults([]); setSearchStatus(''); setSearchIntent(intent);
            }} />
            <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); void searchCities(); }}>
              <label className="sr-only" htmlFor="place-search">{searchIntent === 'wishlist' ? 'Город или место' : 'Страна или город'}</label>
              <input ref={searchInput} id="place-search" value={query} placeholder={searchIntent === 'wishlist' ? 'Город или место' : 'Страна или город'} autoComplete="off"
                minLength={2} maxLength={200} required onChange={event => {
                  searchAbort.current?.abort(); setSearching(false); setResults([]); setSearchStatus(''); setQuery(event.target.value);
                }} />
              <button type="submit" className="icon-button" aria-label={searchIntent === 'wishlist' ? 'Найти место' : 'Найти город'} disabled={searching || query.trim().length < 2}>
                <Search size={20} aria-hidden="true" />
              </button>
            </form>
            {searching ? <p className="hint search-feedback" role="status">Ищем место…</p> : null}
            {searchStatus ? <p className="hint search-feedback" role="status">{searchStatus}</p> : null}
            {searchIntent === 'visited' && listedCountries.length > 0 ? <section className="search-section"><h3>Страны</h3><ul className="place-list">{listedCountries.map(countryRow)}</ul></section> : null}
            {results.length ? <section className="search-section"><h3>Города и места</h3>
              <ul className="place-list" aria-label={searchIntent === 'wishlist' ? 'Результаты поиска места' : 'Результаты поиска города'}>{results.map((result, index) => <li key={`${result.osmRef}-${index}`}>
                <button type="button" disabled={blocked || pendingWrite !== null} onClick={() => acceptCandidate(result)}>
                  <MapPin size={18} aria-hidden="true" /><span className="place-name">{result.name}<small>{result.displayName}</small></span>
                  <ArrowUpRight size={16} className="row-arrow" aria-hidden="true" />
                </button>
              </li>)}</ul>
            </section> : null}
            {!searching && !results.length && !searchStatus ? <p className="search-help">
              {query.trim() ? 'Для поиска нажмите Enter или значок поиска.' : searchIntent === 'wishlist' ? 'Найдите город, парк или другое место для будущей поездки.' : 'Найдите страну или город, где вы побывали.'}
            </p> : null}
            <button type="button" className="map-pick-button" onClick={chooseOnMap} disabled={blocked}>
              <LocateFixed size={20} aria-hidden="true" /><span>Выбрать на карте<small>Поставьте отметку в любой точке</small></span><ArrowRight size={18} aria-hidden="true" />
            </button>
            <a className="search-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Поиск: © OpenStreetMap</a>
          </div> : <div className="collection-content">
            <div className="tabs" role="tablist" aria-label="Список путешествий" onKeyDown={handleTabKeyDown}>
              <button ref={countriesTabRef} type="button" role="tab" id="countries-tab" aria-controls="countries-panel"
                aria-selected={tab === 'countries'} tabIndex={tab === 'countries' ? 0 : -1} onClick={() => setTab('countries')}>Страны <span>{stats.countries}</span></button>
              <button ref={citiesTabRef} type="button" role="tab" id="cities-tab" aria-controls="cities-panel"
                aria-selected={tab === 'cities'} tabIndex={tab === 'cities' ? 0 : -1} onClick={() => setTab('cities')}>Места <span>{stats.cities}</span></button>
              <button ref={wishlistTabRef} type="button" role="tab" id="wishlist-tab" aria-controls="wishlist-panel"
                aria-selected={tab === 'wishlist'} tabIndex={tab === 'wishlist' ? 0 : -1} onClick={() => setTab('wishlist')}>Хочу посетить <span>{stats.wishlist}</span></button>
            </div>
            <section role="tabpanel" id={`${tab}-panel`} aria-labelledby={`${tab}-tab`}>
              {tab === 'countries' ? <ul className="place-list">{savedCountries.map(countryRow)}</ul> : <ul className="place-list">
                {(tab === 'wishlist' ? sortedWishes : sortedCities).map(city => <li key={city.id}>
                  <button type="button" data-city-id={city.id} data-city-list-id={city.id} onClick={() => openCity(city.id)}>
                    {city.status === 'wishlist' ? <Heart size={18} className="wish-icon" aria-hidden="true" /> : <Flag size={18} aria-hidden="true" />}
                    <span className="place-name">{city.name}<small>{city.countryCode ? COUNTRY_BY_CODE.get(city.countryCode)?.name : ''}{latestVisitDate(city) ? `${city.countryCode ? ' · ' : ''}${formatCalendarDate(latestVisitDate(city))}` : ''}</small>
                      {city.status === 'wishlist' && city.wishNote ? <small className="wish-preview">{city.wishNote}</small> : null}
                    </span>
                    <ArrowUpRight size={16} className="row-arrow" aria-hidden="true" />
                  </button>
                </li>)}
              </ul>}
              {(tab === 'countries' ? !savedCountries.length : tab === 'wishlist' ? !sortedWishes.length : !sortedCities.length) ? <div className="empty-state">
                <p>{tab === 'countries' ? 'Какая страна была первой?' : tab === 'wishlist' ? 'Куда зовёт любопытство?' : 'У каждой поездки есть своё место'}</p>
                <span>{tab === 'countries' ? 'Выберите её на карте или найдите по названию.' : tab === 'wishlist' ? 'Сохраните места для будущих поездок. На карте они появятся сердечками.' : 'Добавьте город и пару слов о том, что запомнилось.'}</span>
                {tab !== 'wishlist' ? <button type="button" className="text-button" disabled={blocked} onClick={() => openPanel('search')}>Добавить место<ArrowRight size={16} aria-hidden="true" /></button> : null}
              </div> : null}
              {tab === 'wishlist' ? <button type="button" className="primary wish-primary wide add-wish" disabled={blocked || pendingWrite !== null} onClick={() => openPanel('search', 'wishlist')}><Plus size={18} aria-hidden="true" />Добавить желание</button> : null}
            </section>
            <details className="marker-colors">
              <summary>Цвет отметок</summary>
              <label className="custom-color"><span>Посещённые места</span><input type="color" aria-label="Цвет посещённых мест" value={markerColors.visited} onChange={event => setMarkerColor('visited', event.target.value)} /></label>
              <label className="custom-color"><span>Хочу посетить</span><input type="color" aria-label="Цвет желаний" value={markerColors.wishlist} onChange={event => setMarkerColor('wishlist', event.target.value)} /></label>
              <button type="button" className="text-button" onClick={resetMarkerColors}>Вернуть цвета</button>
            </details>
            <p className="local-save-note">Сохраняется на этом устройстве</p>
          </div>}
        </>}
        {reverseStatus && draft ? <p className="reverse-status hint" role="status">{reverseStatus}</p> : null}
      </aside> : null}

      {isMobile && !activePanel && mode === 'countries' ? <div className="mobile-dock" data-ui-panel="sheet">
        <div className="mobile-dock-caption">{`${stats.countries} ${plural(stats.countries, 'страна', 'страны', 'стран')} · ${stats.cities} ${plural(stats.cities, 'место', 'места', 'мест')} · ${stats.countryVisits} ${plural(stats.countryVisits, 'поездка', 'поездки', 'поездок')}`}</div>
        <div className="mobile-dock-actions">
          <button type="button" className="primary wide" data-focus-id="add-place" disabled={blocked || pendingWrite !== null} onClick={() => openPanel('search')}><Plus size={18} aria-hidden="true" />Добавить место</button>
          {wishlistEntry}
        </div>
      </div> : null}

      <div className="notifications" aria-live="polite">
        {tracker.issue ? <section className="notice" role="alert">
          <p>{tracker.issue.message}</p>
          {tracker.issue.kind === 'corrupt' ? <button type="button" className="text-button" onClick={() => {
            if (window.confirm('Начать заново? Копия прежних данных останется в хранилище этого браузера.')) void tracker.recoverEmpty();
          }}>Начать заново</button> : null}
          {tracker.issue.kind === 'conflict' ? <button type="button" className="text-button" onClick={() => { if (canLeaveDraft()) { startDraft(null); tracker.reload(); } }}>Загрузить изменения</button> : null}
          {tracker.issue.kind === 'unavailable' ? <button type="button" className="text-button" onClick={() => { void tracker.retrySave(); }}>Повторить сохранение</button> : null}
        </section> : null}
        {error ? <div className="notice" role="alert"><p>{error}</p><button type="button" className="icon-button" aria-label="Закрыть сообщение" onClick={() => setError('')}><X size={18} aria-hidden="true" /></button></div> : null}
        {toast ? <div className="save-toast" role="status"><Check size={18} aria-hidden="true" />{toast}</div> : null}
      </div>
    </main>
  );
}

function plural(value: number, one: string, few: string, many: string) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  return value % 10 === 1 ? one : value % 10 >= 2 && value % 10 <= 4 ? few : many;
}
