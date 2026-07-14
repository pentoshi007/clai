/**
 * Renderer lifecycle owner (V2-030).
 *
 * Bootstrap creates the renderer, controllers, and stores inside one `try` and
 * tears them down in `finally`. This object centralizes that contract: it
 * installs bounded signal/error handlers, tears resources down in reverse order
 * exactly once, and guarantees the renderer is destroyed (so alternate-screen
 * reset bytes flush) BEFORE the process exits. The terminal must never be left
 * corrupted, so destruction is idempotent and covered by signal/error tests.
 */

export interface RendererHandle {
  /** Enter alternate screen / take over the terminal. */
  start(): void | Promise<void>;
  /** Leave alternate screen and flush pending reset bytes. */
  destroy(): void | Promise<void>;
}

export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): void;
}

export type Disposer = () => void | Promise<void>;

export interface LifecycleOptions {
  readonly handle: RendererHandle;
  readonly process?: ProcessLike | undefined;
  /** Extra teardown (controllers/stores) disposed in reverse creation order. */
  readonly disposers?: readonly Disposer[] | undefined;
  /** Surfaced errors from signals/uncaught exceptions before shutdown. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

const FATAL_SIGNALS: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

export class RendererLifecycle {
  private readonly proc: ProcessLike;
  private readonly disposers: Disposer[];
  private started = false;
  private shuttingDown = false;
  private destroyed = false;
  private readonly listeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
  }> = [];

  constructor(private readonly options: LifecycleOptions) {
    this.proc = options.process ?? (process as unknown as ProcessLike);
    this.disposers = [...(options.disposers ?? [])];
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Install handlers and hand the terminal to the renderer. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.installHandlers();
    try {
      await this.options.handle.start();
    } catch (error) {
      // Never leave the terminal in the alternate screen if start failed.
      await this.shutdown();
      throw error;
    }
  }

  /**
   * Idempotent teardown: dispose extra resources in reverse order, then destroy
   * the renderer. Safe to call from multiple signals/error paths concurrently.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.removeHandlers();
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      const disposer = this.disposers[i];
      if (!disposer) continue;
      try {
        await disposer();
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    if (!this.destroyed) {
      this.destroyed = true;
      await this.options.handle.destroy();
    }
  }

  /** Tear down fully, then exit — destroy always precedes exit. */
  async shutdownAndExit(code: number): Promise<void> {
    await this.shutdown();
    this.proc.exit(code);
  }

  private installHandlers(): void {
    for (const [signal, code] of Object.entries(FATAL_SIGNALS)) {
      this.addListener(signal, () => {
        void this.shutdownAndExit(code);
      });
    }
    this.addListener("uncaughtException", (error) => {
      this.options.onError?.(error);
      void this.shutdownAndExit(1);
    });
    this.addListener("unhandledRejection", (reason) => {
      this.options.onError?.(reason);
      void this.shutdownAndExit(1);
    });
  }

  private addListener(
    event: string,
    fn: (...args: unknown[]) => void,
  ): void {
    this.proc.on(event, fn);
    this.listeners.push({ event, fn });
  }

  private removeHandlers(): void {
    for (const { event, fn } of this.listeners) {
      this.proc.off(event, fn);
    }
    this.listeners.length = 0;
  }
}
