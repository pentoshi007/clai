import { createElement } from "react";
import { createCliRenderer, RendererControlState, type KeyEvent } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { resolveOpenTuiCapabilities } from "../../ui-core/bootstrap/capabilities.js";
import { createOpenTuiRendererHandle } from "./renderer-handle.js";
import { patchOpenTuiTextContent } from "./patch-opentui-text.js";
import { repaintAttachedScreen } from "./resize-repaint.js";
import { installShrinkResizeGuard } from "./shrink-resize-guard.js";
import { installPasteBurstGuard } from "../input/paste-burst-guard.js";
import { installTerminalRescue } from "../../os/terminal-rescue.js";
import { App } from "../app/App.js";
import type { RuntimeViewTerminal } from "../../session-runtime/view-terminal.js";

export async function mountOpenTuiRuntimeView(
  services: AppServices,
  terminal: RuntimeViewTerminal,
  env: Readonly<Record<string, string>>,
): Promise<{ repaint(): boolean; dispose(): Promise<void> }> {
  patchOpenTuiTextContent();
  let finalized = (): void => {};
  const destroyed = new Promise<void>((resolve) => { finalized = resolve; });
  const renderer = await createCliRenderer({
    stdin: terminal.stdin as unknown as NodeJS.ReadStream,
    stdout: terminal.stdout as unknown as NodeJS.WriteStream,
    screenMode: "alternate-screen", exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled",
    useKittyKeyboard: services.capabilities.kittyKeyboard ? { disambiguate: true, events: true } : null,
    useMouse: true, clearOnShutdown: true, onDestroy: finalized,
  });
  const root = createRoot(renderer);
  const themeMode = await renderer.waitForThemeMode(300).catch(() => null);
  const viewServices = { ...services, capabilities: resolveOpenTuiCapabilities(services.capabilities, env, { themeMode, rgb: renderer.capabilities?.rgb, ansi256: renderer.capabilities?.ansi256 }) };
  const rescue = installTerminalRescue({ stdout: terminal.stdout, stdin: terminal.stdin, proc: terminal });
  const resize = (): void => renderer.resize(terminal.stdout.columns, terminal.stdout.rows);
  terminal.stdout.on("resize", resize);
  const shrink = installShrinkResizeGuard({ renderer, terminal: terminal.stdout, signals: terminal.stdout });
  const paste = installPasteBurstGuard<KeyEvent>(renderer.keyInput);
  const { handle } = createOpenTuiRendererHandle({
    mount: () => root.render(createElement(ServicesProvider, { services: viewServices, children: createElement(App) })),
    unmount: () => root.unmount(), renderer, finalized: destroyed,
    disarmTerminalRescue: rescue, disposeServices: () => {},
  });
  try { await handle.start(); }
  catch (error) { await handle.destroy(); throw error; }
  return {
    repaint: () => repaintAttachedScreen({ renderer, enabled: true, isSuspended: () => renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED }),
    async dispose() {
      terminal.stdout.off("resize", resize);
      shrink();
      paste();
      await handle.destroy();
    },
  };
}
