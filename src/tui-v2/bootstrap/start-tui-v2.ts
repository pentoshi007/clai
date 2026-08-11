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
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import type { Mode, ProviderId } from "../../types.js";
import { App } from "../app/App.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { attachCommandHandlers } from "../../ui-core/commands/command-handlers.js";
import { readCapabilitiesFromProcess } from "../../ui-core/bootstrap/capabilities.js";
import { createCompositionRoot } from "../../ui-core/bootstrap/composition-root.js";
import { RendererLifecycle, type RendererHandle } from "../../ui-core/bootstrap/lifecycle.js";
import { installConsoleGuard } from "../../ui-core/bootstrap/console-guard.js";
import { getLogsDirRoot } from "../../store/paths.js";
import { createOsc52ClipboardPort } from "../../ui-core/ports/clipboard-osc52.js";
import { createPagerExportPort } from "./pager-export.js";
import { patchOpenTuiTextContent } from "./patch-opentui-text.js";
import { setAllowInteractiveStdinInherit } from "../../tools/shell.js";
import { isSuppressedConsoleMessage } from "../../ui-core/bootstrap/console-suppress.js";

export interface StartTuiV2Options {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly noHistory?: boolean | undefined;
}

export async function startTuiV2(
  options: StartTuiV2Options = {},
): Promise<void> {
  patchOpenTuiTextContent();
  setAllowInteractiveStdinInherit(false);
  const capabilities = readCapabilitiesFromProcess();
  const fallbackClipboard = createSystemClipboardPort();
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

  // Stray console output would land in cells the renderer never repaints and
  // stick there for the rest of the session. Route it to a log while the TUI
  // owns the screen; restored during teardown so errors print normally again.
  const restoreConsole = installConsoleGuard({
    logDir: getLogsDirRoot(),
    onCapture: (level, message) => {
      if (level === "error" || level === "warn") {
        if (isSuppressedConsoleMessage(message)) return;
        services.session.notice("warn", message.split("\n")[0]!.slice(0, 200));
      }
    },
  });

  const lifecycle = new RendererLifecycle({
    handle,
    // Flush chat + visual transcript before the renderer is destroyed so an
    // aborted mid-run session still restores tools/code under /history.
    disposers: [
      async () => {
        await services.session.persistNow().catch(() => undefined);
      },
      restoreConsole,
      async () => {
        const result = await services.ports.interactiveSessions
          .closeAll("app-shutdown")
          .catch(() => undefined);
        for (const failure of result?.failures ?? []) {
          process.stderr.write(
            `clai interactive-session cleanup: [${failure.code}] ${failure.message}\n`,
          );
        }
      },
    ],
    // Ctrl+C / SIGINT: first signal aborts a live turn (or arms quit via the
    // App handler path when the key event arrives). A second SIGINT within
    // the window still exits so kill -INT remains usable without the TUI.
    onSigint: () => {
      // Backup path when the key event is not delivered (raw SIGINT). Always
      // dismiss a stuck password/confirm overlay first — abort alone used to
      // leave the sudo modal open and block a clean exit.
      const dismissed = services.overlay.cancelBlockingPrompt();
      if (services.session.getState().running) {
        services.session.abort();
        services.session.notice(
          "info",
          dismissed
            ? "prompt cancelled · Ctrl+C again to exit"
            : "turn aborted · Ctrl+C again to exit",
        );
      } else {
        services.session.notice(
          "info",
          dismissed
            ? "prompt cancelled · Ctrl+C again to exit"
            : "Ctrl+C again to exit",
        );
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
