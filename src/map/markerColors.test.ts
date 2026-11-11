import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKER_COLORS, markerForeground } from './markerColors';

describe('marker colors', () => {
  it('keeps white and black user colors distinguishable with an opposite icon and edge', () => {
    expect(markerForeground('#FFFFFF')).toBe('#172026');
    expect(markerForeground('#000000')).toBe('#FFFFFF');
  });

  it('uses perceptual luminance for bright yellow versus dark blue and the default colors', () => {
    expect(markerForeground('#FFFF00')).toBe('#172026');
    expect(markerForeground('#0000FF')).toBe('#FFFFFF');
    expect(markerForeground('#80ff80')).toBe('#172026');
    expect(markerForeground(DEFAULT_MARKER_COLORS.visited)).toBe('#FFFFFF');
    expect(markerForeground(DEFAULT_MARKER_COLORS.wishlist)).toBe('#FFFFFF');
  });
});
