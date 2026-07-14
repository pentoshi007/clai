/**
 * v2 renderer entry point (V2-030/031/034).
 *
 * Assembles the composition root, creates the OpenTUI renderer in the alternate
 * screen, mounts the empty shell, and hands ownership to `RendererLifecycle` so
 * signals/errors tear the renderer down before the process exits. The renderer
 * runs its own draw loop; this returns once the UI has fully shut down.
 *
 * OpenTUI's native FFI is only available under the Bun runtime, so this path is
 * exercised by `scripts/v2-spikes/shell-render.spike.ts` rather than the Node
 * vitest suite.
 */

import { createElement } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Mode, ProviderId } from "../../types.js";
import { App } from "../app/App.js";
import { ServicesProvider } from "../app/providers.js";
import { createCompositionRoot } from "./composition-root.js";
import { RendererLifecycle, type RendererHandle } from "./lifecycle.js";

export interface StartTuiV2Options {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly noHistory?: boolean | undefined;
}

export async function startTuiV2(
  options: StartTuiV2Options = {},
): Promise<void> {
  const services = createCompositionRoot({
    provider: options.provider,
    model: options.model,
    mode: options.mode,
  });

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
    useMouse: true,
    clearOnShutdown: true,
  });
  const root = createRoot(renderer);

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handle: RendererHandle = {
    start() {
      root.render(
        createElement(
          ServicesProvider,
          { services, children: createElement(App) },
        ),
      );
    },
    destroy() {
      root.unmount();
      renderer.destroy();
      services.dispose();
      resolveDone();
    },
  };

  const lifecycle = new RendererLifecycle({
    handle,
    onError: (error) => {
      // The renderer owns the terminal; surface the error after teardown.
      process.stderr.write(
        `clai v2 error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });

  await lifecycle.start();
  await done;
}
