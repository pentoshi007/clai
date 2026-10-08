import { render, type Instance } from "ink";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { ServicesProvider } from "../../ui-core/react/providers.js";
import { ClassicApp } from "../app/ClassicApp.js";
import { createClassicAppWiring } from "../app/app-wiring.js";
import { createTerminalSession } from "./terminal-session.js";
import { createClassicRenderer } from "./renderer-handle.js";
import { CLASSIC_INK_OPTIONS } from "./start-classic.js";
import type { RuntimeViewTerminal } from "../../session-runtime/view-terminal.js";

export async function mountClassicRuntimeView(
  services: AppServices,
  terminal: RuntimeViewTerminal,
  env: Readonly<Record<string, string>>,
): Promise<{ repaint(): boolean; dispose(): Promise<void> }> {
  const session = createTerminalSession({ stdin: terminal.stdin, stdout: terminal.stdout, proc: terminal, env });
  const wiring = createClassicAppWiring({ services, mouse: session.mouseEnabled, resizeSource: terminal.stdout });
  let instance: Instance | undefined;
  const control = {
    mount() {
      if (instance) return;
      instance = render(
        <ServicesProvider services={services}><ClassicApp wiring={wiring} /></ServicesProvider>,
        { ...CLASSIC_INK_OPTIONS, stdin: terminal.stdin as unknown as NodeJS.ReadStream, stdout: terminal.stdout as unknown as NodeJS.WriteStream, stderr: terminal.stdout as unknown as NodeJS.WriteStream },
      );
    },
    unmount() {
      const current = instance;
      instance = undefined;
      current?.unmount();
      current?.cleanup();
    },
  };
  const { handle } = createClassicRenderer({ session, control, onData: wiring.handleData, disposeServices: () => wiring.dispose() });
  try { await handle.start(); }
  catch (error) { await handle.destroy(); throw error; }
  return {
    repaint() {
      if (!instance) return false;
      control.unmount();
      session.clearScreen();
      control.mount();
      return true;
    },
    dispose: async () => { await handle.destroy(); },
  };
}
