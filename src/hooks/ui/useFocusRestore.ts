import { useCallback, useEffect, useRef, useState } from 'react';

interface StoredOpener {
  element: HTMLElement | null;
  selector: string | null;
}

interface PendingRestore extends StoredOpener {
  fallbackSelector: string | null;
}

function buildSelectorForElement(el: HTMLElement | null): string | null {
  if (!el) return null;
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }
  const testId = el.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${CSS.escape(testId)}"]`;
  }
  const countryCode = el.getAttribute('data-country-code');
  if (countryCode) {
    return `[data-country-code="${CSS.escape(countryCode)}"]`;
  }
  const cityListId = el.getAttribute('data-city-list-id');
  if (cityListId) {
    return `[data-city-list-id="${CSS.escape(cityListId)}"]`;
  }
  const cityId = el.getAttribute('data-city-id');
  if (cityId) {
    return `[data-city-id="${CSS.escape(cityId)}"]`;
  }
  const focusReturn = el.getAttribute('data-focus-id');
  if (focusReturn) {
    return `[data-focus-id="${CSS.escape(focusReturn)}"]`;
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && el.tagName === 'BUTTON') {
    return `button[aria-label="${CSS.escape(ariaLabel)}"]`;
  }
  return null;
}

function canFocusElement(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el.hidden || el.closest('[hidden]') || el.closest('[inert]')) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return true;
}

/**
 * Tracks the opener element or selector before an editor/dialog opens and
 * restores focus after React commits the closing render, even if the opener
 * was temporarily unmounted or inside an inert container while modal was open.
 */
export function useFocusRestore() {
  const openerRef = useRef<StoredOpener>({ element: null, selector: null });
  const pendingRef = useRef<PendingRestore | null>(null);
  const [restoreTick, setRestoreTick] = useState(0);

  const recordOpener = useCallback((explicitSelector?: string | null) => {
    if (typeof document === 'undefined') return;
    if (explicitSelector) {
      const matched = document.querySelector<HTMLElement>(explicitSelector);
      openerRef.current = {
        element: matched,
        selector: explicitSelector,
      };
      return;
    }
    const active =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    openerRef.current = {
      element: active,
      selector: buildSelectorForElement(active),
    };
  }, []);

  const restoreFocus = useCallback((fallbackSelector?: string | null) => {
    const current = openerRef.current;
    openerRef.current = { element: null, selector: null };
    pendingRef.current = {
      element: current.element,
      selector: current.selector,
      fallbackSelector: fallbackSelector ?? null,
    };
    setRestoreTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (restoreTick === 0 || !pendingRef.current || typeof document === 'undefined') return;
    const { element, selector, fallbackSelector } = pendingRef.current;

    const attemptFocus = (): boolean => {
      if (canFocusElement(element)) {
        element.focus();
        if (document.activeElement === element) return true;
      }
      if (selector) {
        const found = document.querySelector<HTMLElement>(selector);
        if (canFocusElement(found)) {
          found.focus();
          if (document.activeElement === found) return true;
        }
      }
      if (fallbackSelector) {
        const fallback = document.querySelector<HTMLElement>(fallbackSelector);
        if (canFocusElement(fallback)) {
          fallback.focus();
          if (document.activeElement === fallback) return true;
        }
      }
      return false;
    };

    if (attemptFocus()) {
      pendingRef.current = null;
      return;
    }

    const frameId = requestAnimationFrame(() => {
      attemptFocus();
      pendingRef.current = null;
    });

    return () => cancelAnimationFrame(frameId);
  }, [restoreTick]);

  return {
    recordOpener,
    restoreFocus,
  };
}
