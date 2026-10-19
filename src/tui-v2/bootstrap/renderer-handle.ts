import type { RendererHandle } from "../../ui-core/bootstrap/lifecycle.js";

export interface OpenTuiRendererControl {
  pause(): void;
  suspend(): void;
  idle(): Promise<void>;
  destroy(): void;
}

export interface OpenTuiRendererHandleParts {
  readonly mount: () => void;
  readonly unmount: () => void;
  readonly renderer: OpenTuiRendererControl;
  readonly finalized: Promise<void>;
  readonly disarmTerminalRescue: () => void;
  readonly disposeServices: () => void;
}

export interface OpenTuiRendererHandle {
  readonly handle: RendererHandle;
  readonly done: Promise<void>;
}

export function createOpenTuiRendererHandle(
  parts: OpenTuiRendererHandleParts,
): OpenTuiRendererHandle {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let suspension: Promise<void> | undefined;
  let unmountError: unknown;
  const suspend = (): Promise<void> => {
    suspension ??= (async () => {
      try { parts.unmount(); }
      catch (error) { unmountError = error; }
      parts.renderer.pause();
      await parts.renderer.idle();
      parts.renderer.suspend();
    })();
    return suspension;
  };
  const handle: RendererHandle = {
    start() {
      parts.mount();
    },
    suspend,
    async destroy() {
      try {
        await suspend();
        parts.renderer.destroy();
        await parts.finalized;
        parts.disarmTerminalRescue();
      } finally {
        parts.disposeServices();
        resolveDone();
      }
      if (unmountError !== undefined) throw unmountError;
    },
  };

  return { handle, done };
}
