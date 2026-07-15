/**
 * Ephemeral right-edge toast queue (UI chrome, not transcript history).
 *
 * Toasts auto-dismiss after a short TTL (default 2s). The host component
 * handles slide-in / slide-out; this controller only owns data + timers.
 */

export type ToastLevel = "info" | "success" | "warn" | "error";

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly level: ToastLevel;
  readonly createdAt: number;
  readonly durationMs: number;
}

export interface ShowToastOptions {
  readonly level?: ToastLevel | undefined;
  /** Visible lifetime including leave animation; default 2000ms. */
  readonly durationMs?: number | undefined;
}

export type ToastListener = () => void;

export const DEFAULT_TOAST_DURATION_MS = 2000;
const MAX_VISIBLE_TOASTS = 4;

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

    const id = `toast-${++this.seq}`;
    const durationMs =
      typeof options.durationMs === "number" &&
      Number.isFinite(options.durationMs) &&
      options.durationMs > 0
        ? Math.floor(options.durationMs)
        : DEFAULT_TOAST_DURATION_MS;

    const item: ToastItem = {
      id,
      message: text.length > 80 ? `${text.slice(0, 77)}…` : text,
      level: options.level ?? "info",
      createdAt: Date.now(),
      durationMs,
    };

    this.items = [...this.items, item].slice(-MAX_VISIBLE_TOASTS);
    // Drop timers for items that fell off the cap.
    for (const [timerId, timer] of this.timers) {
      if (!this.items.some((t) => t.id === timerId)) {
        clearTimeout(timer);
        this.timers.delete(timerId);
      }
    }

    const timer = setTimeout(() => this.dismiss(id), durationMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(id, timer);
    this.emit();
    return id;
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
