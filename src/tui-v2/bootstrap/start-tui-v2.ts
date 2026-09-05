import { createElement } from "react";
import { createCliRenderer, RendererControlState } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import type { Mode, ProviderId } from "../../types.js";
import { App } from "../app/App.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { attachCommandHandlers } from "../../ui-core/commands/command-handlers.js";
import {
  readCapabilitiesFromProcess,
  resolveOpenTuiCapabilities,
} from "../../ui-core/bootstrap/capabilities.js";
import {
  readCachedThemeMode,
  rememberThemeMode,
} from "../../ui-core/bootstrap/theme-mode-cache.js";
import { createCompositionRoot } from "../../ui-core/bootstrap/composition-root.js";
import { RendererLifecycle } from "../../ui-core/bootstrap/lifecycle.js";
import { createExitEpilogue } from "../../ui-core/bootstrap/exit-epilogue.js";
import {
  EXIT_SUMMARY_RESET,
} from "../../os/screen-sequences.js";
import { writeTerminalAndWait } from "../../os/terminal-write.js";
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
import { seedSessionModel } from "../../store/session-model.js";
import { createOpenTuiRendererHandle } from "./renderer-handle.js";
import { repaintAttachedScreen } from "./resize-repaint.js";

export interface StartTuiV2Options {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly modelExplicit?: boolean | undefined;
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
  let forwardConsoleCapture: ((level: string, message: string) => void) | undefined;
  const restoreConsole = installConsoleGuard({
    logDir: getLogsDirRoot(),
    onCapture: (level, message) => forwardConsoleCapture?.(level, message),
  });
  const detectedCapabilities = readCapabilitiesFromProcess();
  const fallbackClipboard = createSystemClipboardPort();
  let markRendererFinalized = (): void => undefined;
  const rendererFinalized = new Promise<void>((resolve) => {
    markRendererFinalized = resolve;
  });
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useKittyKeyboard: detectedCapabilities.kittyKeyboard
      ? { disambiguate: true, events: true }
      : null,
    useMouse: true,
    clearOnShutdown: true,
    onDestroy: markRendererFinalized,
  });
  try {
    (renderer as unknown as { setMaxListeners?: (n: number) => void }).setMaxListeners?.(50);
  } catch {}
  const root = createRoot(renderer);
  root.render(
    createElement("box", {
      style: {
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
      },
    }, createElement("text", { content: "Loading session…" })),
  );
  const requestRepaint = (): boolean =>
    repaintAttachedScreen({
      renderer,
      enabled: Boolean(process.stdout.isTTY),
      isSuspended: () =>
        renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED,
    });
  const runtimeBridge = createRuntimeChildBridge(true);
  runtimeBridge?.setRepaintHandler(requestRepaint);
  if (runtimeBridge) await runtimeBridge.connect();
  let disposeRuntimeBridge = (): void => runtimeBridge?.dispose();
  const reportedThemeMode = await renderer.waitForThemeMode(300).catch(() => null);
  if (reportedThemeMode === "dark" || reportedThemeMode === "light") {
    rememberThemeMode(reportedThemeMode);
  }
  const themeMode = reportedThemeMode ?? readCachedThemeMode() ?? null;
  const nativeCapabilities = renderer.capabilities;
  const capabilities = resolveOpenTuiCapabilities(
    detectedCapabilities,
    process.env,
    {
      themeMode,
      rgb: nativeCapabilities?.rgb,
      ansi256: nativeCapabilities?.ansi256,
    },
  );
  const disarmTerminalRescue = installTerminalRescue();
  const lifecycleRef: { current: RendererLifecycle | undefined } = {
    current: undefined,
  };
  const seeded = await seedSessionModel(options.sessionId, {
    provider: options.provider,
    model: options.model,
    modelExplicit: options.modelExplicit === true,
    inheritLastUsed: options.resume === undefined,
    freeCatalogFallback: options.resume === undefined,
  });
  const services = createCompositionRoot({
    provider: seeded.provider,
    model: seeded.model,
    mode: options.mode,
    noHistory: options.noHistory,
    sessionId: options.sessionId,
    capabilities,
    requestMinimise: () => runtimeBridge?.minimise() ?? false,
    requestSessionSwitch: (sessionId, closeCurrent, fresh) =>
      runtimeBridge?.switchSession(sessionId, closeCurrent, fresh) ?? false,
    clipboard: createOsc52ClipboardPort({
      renderer,
      fallback: fallbackClipboard,
      enabled: capabilities.osc52,
    }),
    pagerExport: createPagerExportPort(renderer),
    requestExit: () => void lifecycleRef.current?.shutdownAndExit(0),
  });
  attachCommandHandlers(services);
  forwardConsoleCapture = (level, message) => {
    if (level === "error" || level === "warn") {
      if (isSuppressedConsoleMessage(message)) return;
      const text = message.split("\n")[0]!.slice(0, 200);
      queueMicrotask(() => services.session.notice("warn", text));
    }
  };
  const epilogue = createExitEpilogue({
    services,
    startedAt,
    enabled: Boolean(process.stdout.isTTY),
    columns: () => process.stdout.columns,
    write: (text) => writeTerminalAndWait(`${EXIT_SUMMARY_RESET}${text}`),
  });
  const pendingResume = options.resume
    ? await resolveResumeTarget(options.resume)
    : undefined;
  await applyResumeResolution(services, pendingResume);

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
    finalized: rendererFinalized,
    disarmTerminalRescue,
    disposeServices: () => services.dispose(),
  });

  const lifecycle = new RendererLifecycle({
    handle,
    disposers: [
      () => disposeRuntimeBridge(),
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
    onSigint: () => {
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

  await lifecycle.start();
  if (runtimeBridge) {
    disposeRuntimeBridge = bindRuntimeChildBridge(
      runtimeBridge,
      services,
      () => void lifecycle.shutdownAndExit(0),
      requestRepaint,
    );
  }

  await done;
  await lifecycle.shutdown();
}
