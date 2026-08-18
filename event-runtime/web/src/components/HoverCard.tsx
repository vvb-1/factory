/**
 * Hover card primitive (WM-700).
 *
 * A hover-only card is a mouse-only card: the operator who drives the console
 * from the keyboard never sees it. This primitive opens on hover *and* on
 * focus, answers Escape by closing and handing focus back, and dismisses
 * itself the moment the table underneath scrolls — a portalled panel pinned to
 * viewport coordinates would otherwise float away from the row it describes.
 *
 * Callers supply the trigger and the panel body; the panel is portalled to
 * `document.body` so a row's `overflow: hidden` cannot clip it.
 */
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/** Hover dwell before opening — long enough that crossing a row does nothing. */
export const OPEN_MS = 180;
/** Grace before closing, so the pointer can cross the gap into the panel. */
export const CLOSE_MS = 150;

/** Default panel width; the collision math needs a number before layout. */
export const HOVER_CARD_WIDTH = 320;
/** Height estimate used only to decide above/below before the panel exists. */
export const HOVER_CARD_HEIGHT = 220;
/** Keep-clear distance from the viewport edge. */
export const VIEWPORT_MARGIN = 12;
/** Gap between the trigger and the panel. */
export const TRIGGER_GAP = 8;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface HoverCardPlacement {
  /** Anchor y: the panel's top edge below, or its bottom edge above. */
  top: number;
  left: number;
  placeAbove: boolean;
}

/**
 * Clamp the panel inside the viewport and flip it above the trigger when the
 * space below cannot hold it. When neither side fits, take the roomier one —
 * a clipped card is still readable, a card drawn off-screen is not.
 */
export function computeHoverCardPosition(
  trigger: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number } = {
    width: HOVER_CARD_WIDTH,
    height: HOVER_CARD_HEIGHT,
  },
): HoverCardPlacement {
  let left = trigger.left;
  if (left + size.width > viewport.width - VIEWPORT_MARGIN) {
    left = viewport.width - size.width - VIEWPORT_MARGIN;
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  const spaceBelow = viewport.height - trigger.bottom;
  const spaceAbove = trigger.top;
  const placeAbove =
    spaceBelow < size.height + TRIGGER_GAP && spaceAbove > spaceBelow;
  const top = placeAbove
    ? trigger.top - TRIGGER_GAP
    : trigger.bottom + TRIGGER_GAP;
  return { top, left, placeAbove };
}

/** Reads the OS motion preference; false wherever `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `prefers-reduced-motion`, kept current if the operator changes it mid-session. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    if (typeof query.addEventListener !== "function") return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface HoverCardApi {
  close: () => void;
}

export interface HoverCardProps {
  /** Accessible name of the panel — it is a dialog, so it needs one. */
  label: string;
  /** What the operator hovers or focuses; the function form receives `close`. */
  trigger: ReactNode | ((api: HoverCardApi) => ReactNode);
  /** Panel body. The function form receives `close` for in-panel actions. */
  children: ReactNode | ((api: HoverCardApi) => ReactNode);
  /**
   * Whether the wrapper is its own tab stop. Pass false when `trigger` already
   * renders a button or link: two tab stops for one thing is worse than none,
   * and focus still bubbles to the wrapper's handlers either way.
   */
  focusable?: boolean;
  className?: string;
  panelClassName?: string;
  width?: number;
  /** Height estimate for the above/below decision before the panel renders. */
  estimatedHeight?: number;
  openDelayMs?: number;
  closeDelayMs?: number;
  onOpenChange?: (open: boolean) => void;
}

export function HoverCard({
  label,
  trigger,
  children,
  focusable = true,
  className,
  panelClassName,
  width = HOVER_CARD_WIDTH,
  estimatedHeight = HOVER_CARD_HEIGHT,
  openDelayMs = OPEN_MS,
  closeDelayMs = CLOSE_MS,
  onOpenChange,
}: HoverCardProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<HoverCardPlacement>({
    top: 0,
    left: 0,
    placeAbove: false,
  });
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const focusPanelRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const notifiedRef = useRef(open);
  const panelId = useId();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (notifiedRef.current === open) return;
    notifiedRef.current = open;
    onOpenChangeRef.current?.(open);
  }, [open]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const reposition = useCallback(() => {
    const el = wrapperRef.current;
    if (!el?.getBoundingClientRect) return;
    const rect = el.getBoundingClientRect();
    setPlacement(
      computeHoverCardPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width, height: estimatedHeight },
      ),
    );
  }, [width, estimatedHeight]);

  const openNow = useCallback(() => {
    clearTimer();
    reposition();
    setOpen(true);
  }, [clearTimer, reposition]);

  const closeNow = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const scheduleOpen = useCallback(() => {
    clearTimer();
    if (openDelayMs <= 0) {
      openNow();
      return;
    }
    timerRef.current = setTimeout(openNow, openDelayMs);
  }, [clearTimer, openDelayMs, openNow]);

  /**
   * Deferred and re-checked on fire: a blur arrives *before* the focusin that
   * caused it, so "did focus leave the card?" can only be answered afterwards.
   * Focus that landed inside the trigger or the panel keeps the card open.
   */
  const scheduleClose = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        const active = document.activeElement as Node | null;
        const inside =
          (active != null && panelRef.current?.contains(active)) ||
          (active != null && wrapperRef.current?.contains(active));
        if (inside) return;
        setOpen(false);
      },
      Math.max(0, closeDelayMs),
    );
  }, [clearTimer, closeDelayMs]);

  /**
   * Hand focus back to the trigger without reopening: the focus event this
   * fires is ours, not the operator's, and Escape must mean the card stays shut.
   */
  const restoreFocus = useCallback(() => {
    const previous = lastFocusRef.current;
    const target = previous?.isConnected ? previous : wrapperRef.current;
    if (!target) return;
    suppressFocusOpenRef.current = true;
    target.focus();
    queueMicrotask(() => {
      suppressFocusOpenRef.current = false;
    });
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // Escape anywhere closes; focus only returns when it was ours to return.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      const inside =
        (panelRef.current?.contains(active as Node) ?? false) ||
        (wrapperRef.current?.contains(active as Node) ?? false);
      closeNow();
      if (inside) restoreFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeNow, restoreFocus]);

  // The panel is pinned to viewport coordinates, so any scroll that is not the
  // panel's own would leave it describing a row that has moved on.
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      closeNow();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, closeNow, reposition]);

  // ArrowDown means "take me into the card", so land focus there once it exists.
  useEffect(() => {
    if (!open || !focusPanelRef.current) return;
    focusPanelRef.current = false;
    const root = panelRef.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus();
  }, [open]);

  const onTriggerFocus = useCallback(
    (e: ReactFocusEvent<HTMLSpanElement>) => {
      lastFocusRef.current = e.target as HTMLElement;
      if (suppressFocusOpenRef.current) return;
      scheduleOpen();
    },
    [scheduleOpen],
  );

  const onTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLSpanElement>) => {
      // Enter is the inner link's own activation key; only claim it when the
      // wrapper itself holds focus and nothing else would act on it.
      const ownEnter = e.key === "Enter" && e.target === e.currentTarget;
      if (e.key !== "ArrowDown" && !ownEnter) return;
      e.preventDefault();
      if (e.key === "ArrowDown") focusPanelRef.current = true;
      openNow();
    },
    [openNow],
  );

  const api: HoverCardApi = { close: closeNow };
  const body = typeof children === "function" ? children(api) : children;
  const triggerBody = typeof trigger === "function" ? trigger(api) : trigger;

  const motion = reducedMotion
    ? ""
    : " transition-opacity duration-150 animate-in fade-in";

  return (
    <>
      <span
        ref={wrapperRef}
        tabIndex={focusable ? 0 : -1}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={onTriggerFocus}
        onBlur={scheduleClose}
        onKeyDown={onTriggerKeyDown}
        className={`inline-flex items-center outline-none focus-visible:ring-1 focus-visible:ring-(--accent) ${className ?? ""}`}
      >
        {triggerBody}
      </span>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            onFocus={clearTimer}
            onBlur={scheduleClose}
            style={{
              position: "fixed",
              top: placement.placeAbove ? undefined : `${placement.top}px`,
              bottom: placement.placeAbove
                ? `${window.innerHeight - placement.top}px`
                : undefined,
              left: `${placement.left}px`,
              width: `${width}px`,
              zIndex: 9999,
            }}
            className={`rounded-lg border border-(--border-strong) bg-(--surface-1) p-3.5 shadow-xl text-[12px] text-(--text) select-text outline-none${motion} ${panelClassName ?? ""}`}
          >
            {body}
          </div>,
          document.body,
        )}
    </>
  );
}
