
export interface RendererHandle {
  start(): void | Promise<void>;
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
  readonly disposers?: readonly Disposer[] | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onSigint?: (() => void) | undefined;
  readonly epilogue?: (() => void | Promise<void>) | undefined;
}

export const SIGINT_QUIT_WINDOW_MS = 1500;

const FATAL_SIGNALS: Record<string, number> = {
  SIGTERM: 143,
  SIGHUP: 129,
};

export class RendererLifecycle {
  private readonly proc: ProcessLike;
  private readonly disposers: Disposer[];
  private started = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private destroyed = false;
  private epilogueRan = false;
  private lastSigintAt = 0;
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.installHandlers();
    try {
      await this.options.handle.start();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
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
      try {
        await this.options.handle.destroy();
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    await this.runEpilogue();
  }

  private async runEpilogue(): Promise<void> {
    if (this.epilogueRan) return;
    this.epilogueRan = true;
    const epilogue = this.options.epilogue;
    if (!epilogue) return;
    try {
      await epilogue();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async shutdownAndExit(code: number): Promise<void> {
    try {
      await this.shutdown();
    } finally {
      this.proc.exit(code);
    }
  }

  private installHandlers(): void {
    this.addListener("SIGINT", () => {
      const now = Date.now();
      if (
        this.lastSigintAt > 0 &&
        now - this.lastSigintAt < SIGINT_QUIT_WINDOW_MS
      ) {
        void this.shutdownAndExit(130);
        return;
      }
      this.lastSigintAt = now;
      try {
        this.options.onSigint?.();
      } catch (error) {
        this.options.onError?.(error);
      }
    });
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
