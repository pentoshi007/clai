/**
 * Ephemeral toast queue (UI chrome, not transcript history).
 *
 * Lifecycle (host animates enter/exit):
 *   enter (~200ms) → hold (default 5000ms) → exit (~200ms) → dismiss
 *
 * Same-key shows update that toast in place, preserving its id, stack position and enter animation.
 */

export type ToastLevel = "info" | "success" | "warn" | "error";

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly level: ToastLevel;
  readonly createdAt: number;
  /** Hold time at rest (ms) — enter/exit animation are extra. */
  readonly durationMs: number;
  /** Optional replace key — new shows with the same key dismiss the old one. */
  readonly key?: string | undefined;
  /** Sticky toasts never auto-dismiss; the caller dismisses them by id. */
  readonly sticky?: boolean | undefined;
}

export interface ShowToastOptions {
  readonly level?: ToastLevel | undefined;
  /** Visible hold at rest; default 5000ms (enter/exit are added on top). */
  readonly durationMs?: number | undefined;
  /**
   * Replace any existing toast with this key (e.g. "thinking", "scroll").
   * Prevents spam when the user hammers a toggle.
   */
  readonly key?: string | undefined;
  /** Keep the toast on screen until explicitly dismissed (no auto-dismiss timer). */
  readonly sticky?: boolean | undefined;
}

export type ToastListener = () => void;

/** Time at rest in the final on-screen position. */
export const DEFAULT_TOAST_DURATION_MS = 5000;
/** Slide-in from top. */
export const TOAST_ENTER_MS = 200;
/** Slide-out back to top. */
export const TOAST_EXIT_MS = 200;

const MAX_VISIBLE_TOASTS = 3;
/**
 * Safety cap only (pathological multi-KB dumps). Normal status lines are not
 * truncated for display — host sizes the chip to the full message.
 */
export const MAX_TOAST_MESSAGE_CHARS = 400;
const MAX_MESSAGE_CHARS = MAX_TOAST_MESSAGE_CHARS;

export function toastTotalLifetimeMs(holdMs: number): number {
  return TOAST_ENTER_MS + Math.max(0, holdMs) + TOAST_EXIT_MS;
}

export class ToastController {
  private items: ToastItem[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<ToastListener>();
  private seq = 0;
  private disposed = false;

  getToasts(): readonly ToastItem[] {
    return this.items;
  }

  subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  show(message: string, options: ShowToastOptions = {}): string {
    if (this.disposed) return "";
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return "";

    const key =
      typeof options.key === "string" && options.key.trim()
        ? options.key.trim()
        : undefined;

    const durationMs =
      typeof options.durationMs === "number" &&
      Number.isFinite(options.durationMs) &&
      options.durationMs > 0
        ? Math.floor(options.durationMs)
        : DEFAULT_TOAST_DURATION_MS;
    const sticky = options.sticky === true;
    const body =
      text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…`
        : text;
    const level = options.level ?? "info";

    if (key) {
      const index = this.items.findIndex((existing) => existing.key === key);
      if (index >= 0) {
        const previous = this.items[index] as ToastItem;
        const item: ToastItem = {
          id: previous.id,
          message: body,
          level,
          createdAt:
            previous.sticky === true && sticky
              ? previous.createdAt
              : Date.now(),
          durationMs,
          key,
          ...(sticky ? { sticky: true } : {}),
        };
        const next = [...this.items];
        next[index] = item;
        this.items = next;
        this.resetTimer(item);
        this.emit();
        return item.id;
      }
    }

    const id = `toast-${++this.seq}`;

    const item: ToastItem = {
      id,
      message: body,
      level,
      createdAt: Date.now(),
      durationMs,
      ...(key ? { key } : {}),
      ...(sticky ? { sticky: true } : {}),
    };

    this.items = [...this.items, item].slice(-MAX_VISIBLE_TOASTS);
    for (const [timerId, timer] of this.timers) {
      if (!this.items.some((t) => t.id === timerId)) {
        clearTimeout(timer);
        this.timers.delete(timerId);
      }
    }

    this.resetTimer(item);
    this.emit();
    return id;
  }

  private resetTimer(item: ToastItem): void {
    const existing = this.timers.get(item.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(item.id);
    }
    if (item.sticky === true) return;
    const timer = setTimeout(
      () => this.dismiss(item.id),
      toastTotalLifetimeMs(item.durationMs),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(item.id, timer);
  }

  info(message: string, options: Omit<ShowToastOptions, "level"> = {}): string {
    return this.show(message, { ...options, level: "info" });
  }

  success(
    message: string,
    options: Omit<ShowToastOptions, "level"> = {},
  ): string {
    return this.show(message, { ...options, level: "success" });
  }

  warn(message: string, options: Omit<ShowToastOptions, "level"> = {}): string {
    return this.show(message, { ...options, level: "warn" });
  }

  error(message: string, options: Omit<ShowToastOptions, "level"> = {}): string {
    return this.show(message, { ...options, level: "error" });
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const next = this.items.filter((t) => t.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
