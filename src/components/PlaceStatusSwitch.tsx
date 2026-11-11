import { Flag, Heart } from 'lucide-react';
import type { PlaceStatus } from '../domain/types';

export function PlaceStatusSwitch({ value, onChange }: { value: PlaceStatus; onChange: (value: PlaceStatus) => void }) {
  return <div className="place-status-switch" role="group" aria-label="Статус места">
    <button type="button" aria-pressed={value === 'visited'} onClick={() => onChange('visited')}>
      <Flag size={16} aria-hidden="true" />Уже посетил
    </button>
    <button type="button" className="wish-option" aria-pressed={value === 'wishlist'} onClick={() => onChange('wishlist')}>
      <Heart size={16} aria-hidden="true" />Хочу посетить
    </button>
  </div>;
}
