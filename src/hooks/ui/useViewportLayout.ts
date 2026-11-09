import { useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT } from '../../map/layout';

export interface ViewportLayoutState {
  isMobile: boolean;
  viewportWidth: number;
  viewportHeight: number;
  visualHeight: number;
  keyboardInset: number;
}

function readViewportState(): ViewportLayoutState {
  if (typeof window === 'undefined') {
    return {
      isMobile: false,
      viewportWidth: 1440,
      viewportHeight: 900,
      visualHeight: 900,
      keyboardInset: 0,
    };
  }

  const viewportWidth = window.innerWidth || 1440;
  const viewportHeight = window.innerHeight || 900;
  const vv = window.visualViewport;
  const visualHeight = vv ? Math.round(vv.height) : viewportHeight;
  const offsetTop = vv ? Math.round(vv.offsetTop) : 0;
  const keyboardInset = Math.max(0, viewportHeight - visualHeight - offsetTop);

  return {
    isMobile: viewportWidth <= MOBILE_BREAKPOINT,
    viewportWidth,
    viewportHeight,
    visualHeight,
    keyboardInset,
  };
}

/**
 * Tracks responsive breakpoint (`<= 760px`) and `visualViewport` metrics,
 * exposing `--visual-viewport-height` and `--keyboard-inset` CSS custom properties
 * so mobile sheets and dialogs remain reachable when the virtual keyboard opens.
 */
export function useViewportLayout(): ViewportLayoutState {
  const [state, setState] = useState<ViewportLayoutState>(readViewportState);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const root = document.documentElement;

    const syncViewport = () => {
      const next = readViewportState();
      root.style.setProperty('--visual-viewport-height', `${next.visualHeight}px`);
      root.style.setProperty('--keyboard-inset', `${next.keyboardInset}px`);
      setState((prev) => {
        if (
          prev.isMobile === next.isMobile &&
          prev.viewportWidth === next.viewportWidth &&
          prev.viewportHeight === next.viewportHeight &&
          prev.visualHeight === next.visualHeight &&
          prev.keyboardInset === next.keyboardInset
        ) {
          return prev;
        }
        return next;
      });
    };

    syncViewport();

    window.addEventListener('resize', syncViewport, { passive: true });
    const vv = window.visualViewport;
    vv?.addEventListener('resize', syncViewport, { passive: true });
    vv?.addEventListener('scroll', syncViewport, { passive: true });

    return () => {
      window.removeEventListener('resize', syncViewport);
      vv?.removeEventListener('resize', syncViewport);
      vv?.removeEventListener('scroll', syncViewport);
    };
  }, []);

  return state;
}
