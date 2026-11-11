import { useEffect, useRef } from 'react';
import { Check, Heart, Plus, Trash2, X } from 'lucide-react';
import { createVisit, markCityVisited, MAX_NAME_LENGTH, MAX_NOTE_LENGTH } from '../domain/tracker';
import type { City, PlaceStatus, Visit } from '../domain/types';
import { PlaceStatusSwitch } from './PlaceStatusSwitch';

interface Props {
  city: City;
  existing: boolean;
  disabled: boolean;
  pendingAction?: 'save' | 'delete' | null;
  onChange: (city: City) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete: () => void;
}

export function CityEditor({ city, existing, disabled, pendingAction, onChange, onSave, onClose, onDelete }: Props) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const latestVisit = city.visits[city.visits.length - 1];
  const earlierVisits = city.visits.slice(0, -1);
  const isWish = city.status === 'wishlist';

  function changeStatus(status: PlaceStatus) {
    if (status === (city.status ?? 'visited')) return;
    if (status === 'visited') { onChange(markCityVisited(city)); return; }
    if ((city.visits.length > 1 || city.visits.some(visit => visit.date)) &&
      !window.confirm('Перенести в желания? Даты и история этого несохранённого места будут убраны.')) return;
    onChange({ ...city, status: 'wishlist', wishNote: city.visits.map(visit => visit.note).filter(Boolean).join('\n\n'), visits: [] });
  }

  useEffect(() => {
    nameInputRef.current?.focus();
  }, [city.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || pendingAction) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pendingAction]);

  function editVisit(visit: Visit, changes: Partial<Pick<Visit, 'date' | 'note'>>) {
    onChange({
      ...city,
      visits: city.visits.map((saved) => saved.id === visit.id ? { ...saved, ...changes } : saved),
    });
  }

  function visitFields(visit: Visit, historical = false) {
    return (
      <>
        <label className="field" htmlFor={`visit-date-${visit.id}`}>
          <span>Дата посещения <span className="optional-label" aria-hidden="true">необязательно</span></span>
          <input
            id={`visit-date-${visit.id}`}
            aria-label="Дата посещения"
            type="date"
            value={visit.date ?? ''}
            onChange={(event) => editVisit(visit, { date: event.target.value || null })}
          />
        </label>
        <label className="field" htmlFor={`visit-note-${visit.id}`}>
          <span>Заметка</span>
          <textarea
            id={`visit-note-${visit.id}`}
            aria-label="Заметка"
            rows={historical ? 2 : 3}
            maxLength={MAX_NOTE_LENGTH}
            value={visit.note}
            placeholder="Что хочется запомнить?"
            onChange={(event) => editVisit(visit, { note: event.target.value })}
          />
        </label>
      </>
    );
  }

  return (
    <section className="editor" aria-label="Редактор места">
      <header className="section-heading">
        <h2 className="editor-heading">{existing ? city.name || 'Ваше место' : isWish ? 'Новое желание' : 'Новое место'}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть редактор" disabled={Boolean(pendingAction)} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <form
        aria-busy={Boolean(pendingAction)}
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && !pendingAction) onSave();
        }}
      >
        {pendingAction ? <p role="status" className="hint">{pendingAction === 'save' ? 'Сохраняем место…' : 'Удаляем место…'}</p> : null}
        <fieldset disabled={disabled || Boolean(pendingAction)}>
          {!existing ? <PlaceStatusSwitch value={city.status ?? 'visited'} onChange={changeStatus} /> : null}
          {existing && isWish ? <p className="wish-label"><Heart size={18} aria-hidden="true" />Хочу посетить</p> : null}
          <label className="field">
            <span>Название места</span>
            <input
              ref={nameInputRef}
              required
              maxLength={MAX_NAME_LENGTH}
              value={city.name}
              placeholder="Например, Париж"
              onChange={(event) => onChange({ ...city, name: event.target.value })}
            />
          </label>
          {isWish ? <label className="field">
            <span>Заметка</span>
            <textarea aria-label="Заметка" rows={3} maxLength={MAX_NOTE_LENGTH} value={city.wishNote ?? ''}
              placeholder="Что хочется здесь увидеть?" onChange={event => onChange({ ...city, wishNote: event.target.value })} />
          </label> : latestVisit ? visitFields(latestVisit) : null}
          {!isWish && (existing || earlierVisits.length > 0) ? (
            <details className="visit-history" key={city.id}>
              <summary>Прошлые поездки{earlierVisits.length ? ` · ${earlierVisits.length}` : ''}</summary>
              {earlierVisits.map((visit, index) => (
                <section key={visit.id} aria-label={`Поездка ${index + 1}`}>
                  <h3>Поездка {index + 1}</h3>
                  {visitFields(visit, true)}
                </section>
              ))}
              {earlierVisits.length === 0 ? <p className="hint">Здесь пока одна поездка.</p> : null}
              <button type="button" className="text-button" onClick={() => onChange({ ...city, visits: [...city.visits, createVisit()] })}>
                <Plus size={16} aria-hidden="true" /> Ещё одна поездка
              </button>
            </details>
          ) : null}
          <div className="editor-submit-row">
            <button className={`primary wide${isWish ? ' wish-primary' : ''}`} type="submit">Сохранить</button>
          </div>
          {existing && isWish ? <button type="button" className="secondary wide mark-visited" onClick={() => changeStatus('visited')}>
            <Check size={18} aria-hidden="true" />Отметить посещённым
          </button> : null}
          {existing ? (
            <button
              type="button"
              className="text-button danger"
              onClick={() => {
                if (window.confirm(isWish ? 'Удалить это место из желаний?' : 'Удалить это место и все воспоминания о нём?')) onDelete();
              }}
            >
              <Trash2 size={16} aria-hidden="true" /> Удалить место
            </button>
          ) : null}
        </fieldset>
      </form>
    </section>
  );
}
