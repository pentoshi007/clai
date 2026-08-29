import { render, type Instance } from "ink";
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import type { Mode, ProviderId } from "../../types.js";
import { attachCommandHandlers } from "../../ui-core/commands/command-handlers.js";
import { readCapabilitiesFromProcess } from "../../ui-core/bootstrap/capabilities.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../ui-core/bootstrap/composition-root.js";
import { installConsoleGuard } from "../../ui-core/bootstrap/console-guard.js";
import { isSuppressedConsoleMessage } from "../../ui-core/bootstrap/console-suppress.js";
import { createExitEpilogue } from "../../ui-core/bootstrap/exit-epilogue.js";
import { NORMAL_SCREEN_RESET } from "../../os/screen-sequences.js";
import { RendererLifecycle } from "../../ui-core/bootstrap/lifecycle.js";
import {
  applyResumeResolution,
  resolveResumeTarget,
  type ResumeTarget,
} from "../../ui-core/bootstrap/session-resume.js";
import { createOsc52ClipboardPort } from "../../ui-core/ports/clipboard-osc52.js";
import { createPagerExportPort } from "../../ui-core/ports/pager-export-port.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { getLogsDirRoot } from "../../store/paths.js";
import { setAllowInteractiveStdinInherit } from "../../tools/shell.js";
import { ClassicApp } from "../app/ClassicApp.js";
import { createClassicAppWiring, type ClassicAppWiring } from "../app/app-wiring.js";
import { createOsc52Renderer } from "./osc52-renderer.js";
import { createClassicRenderer } from "./renderer-handle.js";
import { createRendererSuspendPort, type InkMountControl } from "./suspend-port.js";
import { createTerminalSession } from "./terminal-session.js";
import { createRuntimeChildBridge } from "../../session-runtime/child-bridge.js";
import { bindRuntimeChildBridge } from "../../session-runtime/binding.js";

export interface StartClassicOptions {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly noHistory?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly resume?: ResumeTarget | undefined;
}

export async function startClassic(
  options: StartClassicOptions = {},
): Promise<void> {
  setAllowInteractiveStdinInherit(false);
  const startedAt = Date.now();
  const capabilities = readCapabilitiesFromProcess();
  const session = createTerminalSession();
  const servicesRef: { current: AppServices | undefined } = { current: undefined };
  const wiringRef: { current: ClassicAppWiring | undefined } = { current: undefined };
  const lifecycleRef: { current: RendererLifecycle | undefined } = { current: undefined };
  const runtimeBridge = createRuntimeChildBridge();
  if (runtimeBridge) await runtimeBridge.connect();
  let disposeRuntimeBridge = (): void => runtimeBridge?.dispose();
  let instance: Instance | undefined;

  const control: InkMountControl = {
    mount() {
      const services = servicesRef.current;
      const wiring = wiringRef.current;
      if (!services || !wiring || instance) return;
      instance = render(
        <ServicesProvider services={services}>
          <ClassicApp wiring={wiring} />
        </ServicesProvider>,
        {
          exitOnCtrlC: false,
          patchConsole: false,
          alternateScreen: false,
          concurrent: false,
        },
      );
    },
    unmount() {
      if (!instance) return;
      const current = instance;
      instance = undefined;
      current.unmount();
      current.cleanup();
    },
  };

  const suspendPort = createRendererSuspendPort({ control, session });
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
      renderer: createOsc52Renderer({ session, supported: capabilities.osc52 }),
      fallback: createSystemClipboardPort(),
      enabled: capabilities.osc52,
    }),
    pagerExport: createPagerExportPort(suspendPort),
    requestExit: () => void lifecycleRef.current?.shutdownAndExit(0),
  });
  servicesRef.current = services;
  attachCommandHandlers(services);
  const epilogue = createExitEpilogue({
    services,
    startedAt,
    enabled: capabilities.isTTY,
    columns: () => process.stdout.columns,
    write: (text) => session.write(`${NORMAL_SCREEN_RESET}${text}`),
  });
  const pendingResume = options.resume
    ? await resolveResumeTarget(options.resume)
    : undefined;
  const wiring = createClassicAppWiring({
    services,
    mouse: session.mouseEnabled,
  });
  wiringRef.current = wiring;

  const { handle, done } = createClassicRenderer({
    session,
    control,
    onData: wiring.handleData,
    disposeServices: () => {
      wiring.dispose();
      services.dispose();
    },
  });

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
        `clai classic error: ${error instanceof Error ? error.message : String(error)}`,
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
