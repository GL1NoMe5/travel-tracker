import { useEffect, useRef } from 'react';
import { Check, Plus, X } from 'lucide-react';

export interface CountryEditorProps {
  countryCode: string;
  countryName: string;
  currentColor: string | undefined;
  disabled: boolean;
  onSelectColor: (color: string) => void;
  onResetColor: () => void;
  onClose: () => void;
}

export function CountryEditor({ countryCode, countryName, currentColor, disabled, onSelectColor, onResetColor, onClose }: CountryEditorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isVisited = Boolean(currentColor);

  useEffect(() => {
    headingRef.current?.focus();
  }, [countryCode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <section className="editor country-editor" aria-label="Редактор страны">
      <header className="section-heading">
        <h2 ref={headingRef} tabIndex={-1} className="editor-heading">{countryName}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть страну" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <p className="hint">{isVisited ? 'Ещё одно место в вашей истории.' : 'Бывали здесь? Сохраните страну на своей карте.'}</p>
      <fieldset disabled={disabled}>
        <button type="button" className="primary wide" disabled={isVisited} onClick={() => onSelectColor('#c45b3d')}>
          {isVisited ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
          {isVisited ? 'Отмечено' : 'Я здесь был'}
        </button>
        {isVisited ? <button type="button" className="text-button" onClick={onResetColor}>Убрать отметку</button> : null}
      </fieldset>
    </section>
  );
}
