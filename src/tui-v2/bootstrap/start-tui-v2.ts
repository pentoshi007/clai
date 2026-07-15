/**
 * v2 renderer entry point (V2-030/031/034).
 *
 * Assembles the composition root, creates the OpenTUI renderer in the alternate
 * screen, mounts the shell, and hands ownership to `RendererLifecycle` so
 * signals/errors tear the renderer down before the process exits.
 */

import { createElement } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createInMemoryClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import type { Mode, ProviderId } from "../../types.js";
import { App } from "../app/App.js";
import { ServicesProvider } from "../app/providers.js";
import { attachCommandHandlers } from "../app/command-handlers.js";
import { readCapabilitiesFromProcess } from "./capabilities.js";
import { createCompositionRoot } from "./composition-root.js";
import { RendererLifecycle, type RendererHandle } from "./lifecycle.js";
import { createOsc52ClipboardPort } from "./osc52-clipboard.js";
import { createPagerExportPort } from "./pager-export.js";

export interface StartTuiV2Options {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly noHistory?: boolean | undefined;
}

export async function startTuiV2(
  options: StartTuiV2Options = {},
): Promise<void> {
  // OpenTUI native drag-select is enabled. Interactive chrome (prompts/tools/
  // composer) sets selectable={false}; response/thinking body stays selectable.
  // Copy-on-release is wired in TranscriptView via useNativeSelectionCopy.
  const capabilities = readCapabilitiesFromProcess();
  const fallbackClipboard = createInMemoryClipboardPort();
  // We own Ctrl+C (abort then double-press exit). OpenTUI must not kill the
  // process on the first press, and SIGINT is handled cooperatively below.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useMouse: true,
    clearOnShutdown: true,
  });
  // lifecycle is assigned before requestExit runs; use a holder so the
  // composition root can close over a stable callback.
  const lifecycleRef: { current: RendererLifecycle | undefined } = {
    current: undefined,
  };
  const services = createCompositionRoot({
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    noHistory: options.noHistory,
    capabilities,
    clipboard: createOsc52ClipboardPort({
      renderer,
      fallback: fallbackClipboard,
      enabled: capabilities.osc52,
    }),
    pagerExport: createPagerExportPort(renderer),
    requestExit: () => void lifecycleRef.current?.shutdownAndExit(0),
  });
  attachCommandHandlers(services);
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
    // Ctrl+C / SIGINT: first signal aborts a live turn (or arms quit via the
    // App handler path when the key event arrives). A second SIGINT within
    // the window still exits so kill -INT remains usable without the TUI.
    onSigint: () => {
      // Backup path when the key event is not delivered (raw SIGINT). The App
      // keyboard handler owns the normal Ctrl+C double-press UX.
      if (services.session.getState().running) {
        services.session.abort();
        services.session.notice(
          "info",
          "turn aborted · Ctrl+C again to exit",
        );
      } else {
        services.session.notice("info", "Ctrl+C again to exit");
      }
    },
    onError: (error) => {
      // The renderer owns the terminal; surface the error after teardown.
      process.stderr.write(
        `clai v2 error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });
  lifecycleRef.current = lifecycle;

  await lifecycle.start();
  await done;
}
