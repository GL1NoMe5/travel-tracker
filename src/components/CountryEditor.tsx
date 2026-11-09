import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, X } from 'lucide-react';
import { COLOR_PRESETS, DEFAULT_COUNTRY_COLOR, MAX_COUNTRY_VISITS } from '../domain/tracker';

export interface CountryEditorProps {
  countryCode: string;
  countryName: string;
  currentColor: string | undefined;
  visitCount: number;
  disabled: boolean;
  onSelectColor: (color: string) => void;
  onResetColor: () => void;
  onSetVisitCount: (count: number) => void;
  onClose: () => void;
}

export function CountryEditor({ countryCode, countryName, currentColor, visitCount, disabled, onSelectColor, onResetColor, onSetVisitCount, onClose }: CountryEditorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isVisited = Boolean(currentColor);
  const [countInput, setCountInput] = useState(String(visitCount || 1));
  const [countError, setCountError] = useState('');
  const countDirty = useRef(false);
  useEffect(() => {
    if (disabled) return;
    setCountInput(String(visitCount || 1)); setCountError(''); countDirty.current = false;
  }, [countryCode, visitCount, disabled]);

  function saveCount() {
    if (disabled || !countDirty.current) return;
    const count = Number(countInput);
    if (!/^\d+$/.test(countInput) || !Number.isInteger(count) || count < 1 || count > MAX_COUNTRY_VISITS) {
      setCountError(`Введите число от 1 до ${MAX_COUNTRY_VISITS}.`);
      return;
    }
    setCountError('');
    countDirty.current = false;
    if (count !== visitCount) onSetVisitCount(count);
  }

  function stepCount(delta: number) {
    const base = countDirty.current ? Number(countInput) : visitCount;
    if (countDirty.current && (!/^\d+$/.test(countInput) || !Number.isInteger(base) || base < 1 || base > MAX_COUNTRY_VISITS)) {
      setCountError(`Введите число от 1 до ${MAX_COUNTRY_VISITS}.`);
      return;
    }
    const next = Math.max(1, Math.min(MAX_COUNTRY_VISITS, base + delta));
    countDirty.current = false;
    setCountInput(String(next));
    setCountError('');
    if (next !== visitCount) onSetVisitCount(next);
  }

  function requestClose() {
    if (disabled) return;
    if (countDirty.current && countInput !== String(visitCount || 1) && !window.confirm('Закрыть без сохранения количества посещений?')) return;
    onClose();
  }

  useEffect(() => {
    headingRef.current?.focus();
  }, [countryCode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, disabled, countInput, visitCount]);

  return (
    <section className="editor country-editor" aria-label="Редактор страны">
      <header className="section-heading">
        <h2 ref={headingRef} tabIndex={-1} className="editor-heading">{countryName}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть страну" disabled={disabled} onClick={requestClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <p className="hint">{isVisited ? 'Выберите цвет и отметьте, сколько раз здесь побывали.' : 'Выберите цвет, чтобы отметить страну на своей карте.'}</p>
      <fieldset disabled={disabled}>
        <legend className="sr-only">Цвет и посещения страны</legend>
        <div className="country-palette" role="group" aria-label="Палитра цветов страны">
          {COLOR_PRESETS.map(color => <button type="button" key={color} className="color-swatch"
            aria-label={`Цвет: ${color}`} aria-pressed={currentColor?.toUpperCase() === color.toUpperCase()}
            style={{ backgroundColor: color }} onClick={() => onSelectColor(color)}>
            {currentColor?.toUpperCase() === color.toUpperCase() ? <Check size={20} aria-hidden="true" /> : null}
          </button>)}
        </div>
        <label className="custom-color"><span>Свой цвет</span><input type="color" aria-label="Свой цвет страны"
          value={currentColor ?? DEFAULT_COUNTRY_COLOR} onChange={event => onSelectColor(event.target.value)} /></label>
        <section className="country-visits" aria-label="Посещения страны">
          <label htmlFor="country-visit-count">Количество посещений</label>
          <div className="visit-stepper">
            <button type="button" className="secondary" aria-label="Уменьшить количество посещений" disabled={(countDirty.current ? Number(countInput) : visitCount) <= 1}
              onPointerDown={event => event.preventDefault()} onClick={() => stepCount(-1)}><Minus size={18} aria-hidden="true" /></button>
            <input id="country-visit-count" type="number" inputMode="numeric" min={1} max={MAX_COUNTRY_VISITS} step={1}
              value={countInput} aria-invalid={Boolean(countError)} aria-describedby={countError ? 'count-error' : undefined}
              onChange={event => { setCountInput(event.target.value); setCountError(''); countDirty.current = true; }} onBlur={saveCount}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveCount(); } }} />
            <button type="button" className="secondary" aria-label="Добавить посещение" disabled={(countDirty.current ? Number(countInput) : visitCount) >= MAX_COUNTRY_VISITS}
              onPointerDown={event => event.preventDefault()} onClick={() => stepCount(1)}><Plus size={18} aria-hidden="true" /></button>
          </div>
          {countError ? <p id="count-error" className="hint danger" role="alert">{countError}</p> : null}
          <p className="hint">Каждая поездка считается один раз, даже если вы посетили несколько городов.</p>
        </section>
        <button type="button" className="primary wide" disabled={isVisited} onClick={() => onSelectColor(DEFAULT_COUNTRY_COLOR)}>
          {isVisited ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
          {isVisited ? 'Отмечено' : 'Я здесь был'}
        </button>
        {isVisited ? <button type="button" className="text-button" onClick={onResetColor}>Убрать отметку</button> : null}
      </fieldset>
    </section>
  );
}
