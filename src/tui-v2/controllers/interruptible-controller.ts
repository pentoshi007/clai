/**
 * Registry for cancellable non-session operations (e.g. /update download and
 * install). Session turns and Responder jobs have their own cancellation
 * paths; this covers fire-and-forget command handlers so Esc / Ctrl+C can
 * abort them instead of leaving them running until they settle.
 */
export class InterruptibleController {
  private readonly controllers = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();

  begin(): AbortController {
    const controller = new AbortController();
    this.controllers.add(controller);
    this.emit();
    return controller;
  }

  end(controller: AbortController): void {
    if (this.controllers.delete(controller)) this.emit();
  }

  hasWork(): boolean {
    return this.controllers.size > 0;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const controller of [...this.controllers]) {
      if (!controller.signal.aborted) {
        controller.abort();
        cancelled += 1;
      }
    }
    this.controllers.clear();
    if (cancelled > 0) this.emit();
    return cancelled;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.cancelAll();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}