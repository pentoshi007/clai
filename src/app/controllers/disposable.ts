export interface Disposable {
  dispose(): void;
}

/**
 * Owns a set of disposables and tears them down in reverse creation order
 * (ARCHITECTURE.md lifecycle). Disposal is idempotent (REL-001): a second call
 * is a no-op, and one throwing disposer does not prevent the rest from running.
 */
export class CompositeDisposable implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      try {
        this.items[i]?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.items.length = 0;
    if (errors.length > 0) throw errors[0];
  }
}
