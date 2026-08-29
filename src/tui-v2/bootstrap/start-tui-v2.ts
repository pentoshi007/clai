/**
 * v2 renderer entry point (V2-030/031/034).
 *
 * Assembles the composition root, creates the OpenTUI renderer in the alternate
 * screen, mounts the shell, and hands ownership to `RendererLifecycle` so
 * signals/errors tear the renderer down before the process exits.
 */

import { createElement } from "react";
import { createCliRenderer, RendererControlState } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import type { Mode, ProviderId } from "../../types.js";
import { App } from "../app/App.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { attachCommandHandlers } from "../../ui-core/commands/command-handlers.js";
import { readCapabilitiesFromProcess } from "../../ui-core/bootstrap/capabilities.js";
import { createCompositionRoot } from "../../ui-core/bootstrap/composition-root.js";
import { RendererLifecycle } from "../../ui-core/bootstrap/lifecycle.js";
import { createExitEpilogue } from "../../ui-core/bootstrap/exit-epilogue.js";
import {
  NORMAL_SCREEN_RESET,
} from "../../os/screen-sequences.js";
import {
  applyResumeResolution,
  resolveResumeTarget,
  type ResumeTarget,
} from "../../ui-core/bootstrap/session-resume.js";
import { installConsoleGuard } from "../../ui-core/bootstrap/console-guard.js";
import { installTerminalRescue } from "../../os/terminal-rescue.js";
import { getLogsDirRoot } from "../../store/paths.js";
import { createOsc52ClipboardPort } from "../../ui-core/ports/clipboard-osc52.js";
import { createPagerExportPort } from "./pager-export.js";
import { patchOpenTuiTextContent } from "./patch-opentui-text.js";
import { setAllowInteractiveStdinInherit } from "../../tools/shell.js";
import { isSuppressedConsoleMessage } from "../../ui-core/bootstrap/console-suppress.js";
import { createRuntimeChildBridge } from "../../session-runtime/child-bridge.js";
import { bindRuntimeChildBridge } from "../../session-runtime/binding.js";
import { createOpenTuiRendererHandle } from "./renderer-handle.js";
import { installResizeRepaint } from "./resize-repaint.js";

export interface StartTuiV2Options {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly noHistory?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly resume?: ResumeTarget | undefined;
}

export async function startTuiV2(
  options: StartTuiV2Options = {},
): Promise<void> {
  patchOpenTuiTextContent();
  setAllowInteractiveStdinInherit(false);
  const startedAt = Date.now();
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
  const disarmTerminalRescue = installTerminalRescue();
  // lifecycle is assigned before requestExit runs; use a holder so the
  // composition root can close over a stable callback.
  const lifecycleRef: { current: RendererLifecycle | undefined } = {
    current: undefined,
  };
  const runtimeBridge = createRuntimeChildBridge();
  if (runtimeBridge) await runtimeBridge.connect();
  let disposeRuntimeBridge = (): void => runtimeBridge?.dispose();
  const services = createCompositionRoot({
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    noHistory: options.noHistory,
    sessionId: options.sessionId,
    capabilities,
    requestMinimise: () => runtimeBridge?.minimise() ?? false,
    requestSessionSwitch: (sessionId, closeCurrent) =>
      runtimeBridge?.switchSession(sessionId, closeCurrent) ?? false,
    clipboard: createOsc52ClipboardPort({
      renderer,
      fallback: fallbackClipboard,
      enabled: capabilities.osc52,
    }),
    pagerExport: createPagerExportPort(renderer),
    requestExit: () => void lifecycleRef.current?.shutdownAndExit(0),
  });
  attachCommandHandlers(services);
  const epilogue = createExitEpilogue({
    services,
    startedAt,
    enabled: Boolean(process.stdout.isTTY),
    columns: () => process.stdout.columns,
    write: (text) => {
      try {
        process.stdout.write(`${NORMAL_SCREEN_RESET}${text}`);
      } catch {
        /* the terminal went away; nothing to sign off to */
      }
    },
  });
  const pendingResume = options.resume
    ? await resolveResumeTarget(options.resume)
    : undefined;
  const root = createRoot(renderer);

  const { handle, done } = createOpenTuiRendererHandle({
    mount: () => {
      root.render(
        createElement(
          ServicesProvider,
          { services, children: createElement(App) },
        ),
      );
    },
    unmount: () => root.unmount(),
    renderer,
    disarmTerminalRescue,
    disposeServices: () => services.dispose(),
  });

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

  const disposeResizeRepaint = installResizeRepaint({
    renderer,
    write: (text) => void process.stdout.write(text),
    enabled: Boolean(process.stdout.isTTY),
    isSuspended: () =>
      renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED,
  });

  const lifecycle = new RendererLifecycle({
    handle,
    // Flush chat + visual transcript before the renderer is destroyed so an
    // aborted mid-run session still restores tools/code under /history.
    disposers: [
      () => disposeRuntimeBridge(),
      disposeResizeRepaint,
      epilogue.capture,
      async () => {
        await services.session.persistNow().catch(() => undefined);
      },
      restoreConsole,
      async () => {
        await services.mcp.closeAll().catch(() => undefined);
      },
      async () => {
        const result = await services.ports.interactiveSessions
          .closeAll("app-shutdown")
          .catch(() => undefined);
        for (const failure of result?.failures ?? []) {
          console.warn(
            `clai interactive-session cleanup: [${failure.code}] ${failure.message}`,
          );
        }
      },
    ],
    epilogue: epilogue.run,
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
      console.error(
        `clai v2 error: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  lifecycleRef.current = lifecycle;
  if (runtimeBridge) {
    disposeRuntimeBridge = bindRuntimeChildBridge(
      runtimeBridge,
      services,
      () => void lifecycle.shutdownAndExit(0),
    );
  }

  await lifecycle.start();
  await applyResumeResolution(services, pendingResume);
  await done;
}
