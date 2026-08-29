import type { RendererHandle } from "../../ui-core/bootstrap/lifecycle.js";

export interface OpenTuiRendererControl {
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

  const handle: RendererHandle = {
    start() {
      parts.mount();
    },
    async destroy() {
      let unmountError: unknown;
      try {
        parts.unmount();
      } catch (error) {
        unmountError = error;
      }
      try {
        parts.renderer.suspend();
        await parts.renderer.idle();
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
