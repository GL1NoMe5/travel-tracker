import type { PaddingOptions } from 'maplibre-gl';

export const MOBILE_BREAKPOINT = 760;

export const DESKTOP_OUTER_MARGIN = 20;
export const DESKTOP_SIDEBAR_WIDTH = 320;
export const DESKTOP_EDITOR_WIDTH = 340;
export const DESKTOP_PANEL_GAP = 16;
export const DESKTOP_TOPBAR_HEIGHT = 64;

export const MOBILE_OUTER_MARGIN = 10;
export const MOBILE_TOPBAR_HEIGHT = 86;
export const MOBILE_COLLAPSED_SHEET_HEIGHT = 118;
export const MOBILE_PANEL_GAP = 12;

export type MobileSheetMode = 'collapsed' | 'expanded' | 'editor';

export interface PanelPaddingOptions {
  hasRightPanel?: boolean;
  leftPanelOpen?: boolean;
  mobileSheetMode?: MobileSheetMode;
}

function toEven(value: number): number {
  return Math.round(value / 2) * 2;
}

/**
 * Pure calculation of MapLibre camera padding from viewport size and panel state,
 * using unified CSS panel dimensions.
 */
export function computePanelPadding(
  width: number,
  height: number,
  options: boolean | PanelPaddingOptions = false,
): Required<PaddingOptions> {
  const opts: PanelPaddingOptions =
    typeof options === 'boolean' ? { hasRightPanel: options } : options;
  const hasRightPanel = Boolean(opts.hasRightPanel);
  const leftPanelOpen = opts.leftPanelOpen ?? true;
  const mobileSheetMode: MobileSheetMode =
    opts.mobileSheetMode ?? (hasRightPanel ? 'editor' : 'collapsed');

  const safeW = Math.max(320, width);
  const safeH = Math.max(320, height);

  if (safeW <= MOBILE_BREAKPOINT) {
    const top = toEven(
      Math.min(132, MOBILE_OUTER_MARGIN + MOBILE_TOPBAR_HEIGHT + MOBILE_PANEL_GAP),
    );
    let rawBottom: number;
    if (mobileSheetMode === 'collapsed') {
      rawBottom =
        MOBILE_OUTER_MARGIN + MOBILE_COLLAPSED_SHEET_HEIGHT + MOBILE_PANEL_GAP;
    } else {
      rawBottom = Math.round(safeH * 0.52);
    }
    const maxAllowedBottom = Math.max(120, safeH - top - 120);
    const bottom = toEven(Math.min(rawBottom, maxAllowedBottom));
    return {
      top,
      bottom,
      left: MOBILE_OUTER_MARGIN + 6,
      right: MOBILE_OUTER_MARGIN + 6,
    };
  }

  const top = toEven(DESKTOP_OUTER_MARGIN + DESKTOP_TOPBAR_HEIGHT + DESKTOP_PANEL_GAP);
  const left = leftPanelOpen
    ? toEven(
        Math.min(
          DESKTOP_OUTER_MARGIN + DESKTOP_SIDEBAR_WIDTH + DESKTOP_PANEL_GAP,
          Math.round(safeW * 0.34),
        ),
      )
    : DESKTOP_OUTER_MARGIN;
  const right = hasRightPanel
    ? toEven(
        Math.min(
          DESKTOP_OUTER_MARGIN + DESKTOP_EDITOR_WIDTH + DESKTOP_PANEL_GAP,
          Math.round(safeW * 0.36),
        ),
      )
    : DESKTOP_OUTER_MARGIN;

  return {
    top,
    bottom: DESKTOP_OUTER_MARGIN,
    left,
    right,
  };
}

function isElementVisible(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hidden || el.closest('[hidden]')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Measures actual visible UI panels in the DOM and computes MapLibre camera padding
 * plus CSS free-area offsets for map controls and attribution.
 */
export function measureDomViewportPadding(
  container: HTMLElement | null,
  fallbackHasRightPanel: boolean,
): { width: number; height: number; padding: Required<PaddingOptions> } {
  const width =
    container?.clientWidth ||
    (typeof window !== 'undefined' ? window.innerWidth : 1280) ||
    1280;
  const height =
    container?.clientHeight ||
    (typeof window !== 'undefined' ? window.innerHeight : 800) ||
    800;

  if (typeof document === 'undefined') {
    return {
      width,
      height,
      padding: computePanelPadding(width, height, fallbackHasRightPanel),
    };
  }

  const topbar = document.querySelector('[data-ui-panel="topbar"], .topbar');
  const sidebar = document.querySelector('[data-ui-panel="sidebar"]');
  const editor = document.querySelector('[data-ui-panel="editor"]');
  const sheet = document.querySelector('[data-ui-panel="sheet"]');

  const hasMountedPanels =
    isElementVisible(topbar) ||
    isElementVisible(sidebar) ||
    isElementVisible(editor) ||
    isElementVisible(sheet);

  if (!hasMountedPanels) {
    return {
      width,
      height,
      padding: computePanelPadding(width, height, fallbackHasRightPanel),
    };
  }

  const isMobile = width <= MOBILE_BREAKPOINT;
  const topbarRect = isElementVisible(topbar) ? topbar.getBoundingClientRect() : null;

  let padding: Required<PaddingOptions>;

  if (isMobile) {
    const top = toEven(
      topbarRect
        ? Math.min(160, Math.max(72, Math.round(topbarRect.bottom + MOBILE_PANEL_GAP)))
        : MOBILE_OUTER_MARGIN + MOBILE_TOPBAR_HEIGHT + MOBILE_PANEL_GAP,
    );

    let bottom = MOBILE_OUTER_MARGIN + MOBILE_COLLAPSED_SHEET_HEIGHT + MOBILE_PANEL_GAP;
    if (isElementVisible(sheet)) {
      const sheetRect = sheet.getBoundingClientRect();
      const occupiedFromBottom = Math.max(0, height - sheetRect.top);
      bottom = Math.round(occupiedFromBottom + MOBILE_PANEL_GAP);
    }

    const maxAllowedBottom = Math.max(110, height - top - 120);
    padding = {
      top,
      bottom: toEven(Math.min(bottom, maxAllowedBottom)),
      left: MOBILE_OUTER_MARGIN + 6,
      right: MOBILE_OUTER_MARGIN + 6,
    };
  } else {
    const top = toEven(
      topbarRect
        ? Math.min(140, Math.max(76, Math.round(topbarRect.bottom + DESKTOP_PANEL_GAP)))
        : DESKTOP_OUTER_MARGIN + DESKTOP_TOPBAR_HEIGHT + DESKTOP_PANEL_GAP,
    );

    let left = DESKTOP_OUTER_MARGIN;
    if (isElementVisible(sidebar)) {
      const sidebarRect = sidebar.getBoundingClientRect();
      left = toEven(
        Math.min(
          Math.round(sidebarRect.right + DESKTOP_PANEL_GAP),
          Math.round(width * 0.42),
        ),
      );
    }

    let right = DESKTOP_OUTER_MARGIN;
    if (isElementVisible(editor)) {
      const editorRect = editor.getBoundingClientRect();
      const occupiedFromRight = Math.max(0, width - editorRect.left);
      right = toEven(
        Math.min(
          Math.round(occupiedFromRight + DESKTOP_PANEL_GAP),
          Math.max(120, width - left - 120),
        ),
      );
    } else if (fallbackHasRightPanel && !editor) {
      right = computePanelPadding(width, height, {
        hasRightPanel: true,
        leftPanelOpen: isElementVisible(sidebar),
      }).right;
    }

    padding = {
      top,
      bottom: DESKTOP_OUTER_MARGIN,
      left,
      right,
    };
  }

  const mapRoot = container?.closest('.travel-map') as HTMLElement | null;
  if (mapRoot) {
    mapRoot.style.setProperty('--map-free-top', `${padding.top}px`);
    mapRoot.style.setProperty('--map-free-bottom', `${padding.bottom}px`);
    mapRoot.style.setProperty('--map-free-left', `${padding.left}px`);
    mapRoot.style.setProperty('--map-free-right', `${padding.right}px`);
  }

  return { width, height, padding };
}

/**
 * Observes visible UI panels (header, collapsible sidebar, right editor, mobile sheet)
 * and invokes `onLayoutChange` whenever panel visibility or geometry changes.
 */
export function observeUiPanels(onLayoutChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  let frameId: number | null = null;
  const scheduleNotify = () => {
    if (frameId !== null) return;
    frameId = requestAnimationFrame(() => {
      frameId = null;
      onLayoutChange();
    });
  };

  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          scheduleNotify();
        })
      : null;

  const panelSelector =
    '[data-ui-panel], .topbar, .sidebar, .country-editor, .editor-stack, .mobile-sheet';
  const observedPanels = new Set<Element>();
  const observeCurrentPanels = () => {
    if (!resizeObserver) return;
    const panels = new Set(document.querySelectorAll(panelSelector));
    for (const panel of observedPanels) {
      if (!panels.has(panel)) {
        resizeObserver.unobserve(panel);
        observedPanels.delete(panel);
      }
    }
    for (const panel of panels) {
      if (!observedPanels.has(panel)) {
        observedPanels.add(panel);
        resizeObserver.observe(panel);
      }
    }
  };

  observeCurrentPanels();

  const appRoot = document.querySelector('.app') ?? document.body;
  const containsPanel = (node: Node) => node instanceof Element && (
    observedPanels.has(node) || node.matches(panelSelector) || Boolean(node.querySelector(panelSelector))
  );
  const mutationObserver =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(records => {
          // MapLibre updates its own marker/control classes and DOM while rendering.
          // Only changes to UI panel branches can affect the measured free area.
          const panelsChanged = records.some(record => record.type === 'attributes'
            ? containsPanel(record.target)
            : [...record.addedNodes, ...record.removedNodes].some(containsPanel));
          if (!panelsChanged) return;
          observeCurrentPanels();
          scheduleNotify();
        })
      : null;

  mutationObserver?.observe(appRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'class', 'data-sheet-state', 'data-panel-collapsed'],
  });

  const vv = window.visualViewport;
  vv?.addEventListener('resize', scheduleNotify);
  vv?.addEventListener('scroll', scheduleNotify);

  return () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    resizeObserver?.disconnect();
    observedPanels.clear();
    mutationObserver?.disconnect();
    vv?.removeEventListener('resize', scheduleNotify);
    vv?.removeEventListener('scroll', scheduleNotify);
  };
}
