import { describe, expect, it } from 'vitest';
import { computePanelPadding } from './layout';

describe('map layout padding calculations', () => {
  it('computes desktop padding with sidebar open and editor closed or open', () => {
    const withoutEditor = computePanelPadding(1440, 900, false);
    expect(withoutEditor).toEqual({
      top: 100,
      bottom: 20,
      left: 356,
      right: 20,
    });

    const withEditor = computePanelPadding(1440, 900, true);
    expect(withEditor).toEqual({
      top: 100,
      bottom: 20,
      left: 356,
      right: 376,
    });
  });

  it('releases left padding when desktop sidebar is collapsed', () => {
    const collapsedLeft = computePanelPadding(1440, 900, {
      leftPanelOpen: false,
      hasRightPanel: true,
    });
    expect(collapsedLeft).toEqual({
      top: 100,
      bottom: 20,
      left: 20,
      right: 376,
    });
  });

  it('computes mobile padding for collapsed, expanded, and editor sheet states', () => {
    const collapsed = computePanelPadding(390, 844, {
      mobileSheetMode: 'collapsed',
    });
    expect(collapsed.left).toBe(16);
    expect(collapsed.right).toBe(16);
    expect(collapsed.top).toBeLessThanOrEqual(132);
    expect(collapsed.bottom).toBe(140);

    const expanded = computePanelPadding(390, 844, {
      mobileSheetMode: 'expanded',
    });
    expect(expanded.bottom).toBeGreaterThan(collapsed.bottom);
    expect(expanded.bottom).toBe(440);

    const editor = computePanelPadding(390, 844, true);
    expect(editor.bottom).toBe(expanded.bottom);
  });
});
