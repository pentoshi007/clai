import type { RendererHandle } from "../../ui-core/bootstrap/lifecycle.js";
import { settleWithin } from "../../os/settle-within.js";

export const RENDERER_TEARDOWN_BUDGET_MS = 1_000;

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
  readonly teardownBudgetMs?: number | undefined;
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

  const budget = parts.teardownBudgetMs ?? RENDERER_TEARDOWN_BUDGET_MS;
  let suspension: Promise<void> | undefined;
  let unmountError: unknown;
  const suspend = (): Promise<void> => {
    suspension ??= (async () => {
      try { parts.unmount(); }
      catch (error) { unmountError = error; }
      parts.renderer.pause();
      await settleWithin(parts.renderer.idle(), budget);
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
        await settleWithin(parts.finalized, budget);
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
