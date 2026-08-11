import type { RendererSuspendPort } from "../../ui-core/ports/pager-export-port.js";
import type { TerminalSession } from "./terminal-session.js";

export interface InkMountControl {
  mount(): void;
  unmount(): void;
}

export interface SuspendPortOptions {
  readonly control: InkMountControl;
  readonly session: TerminalSession;
}

export interface ClassicSuspendPort extends RendererSuspendPort {
  readonly suspended: boolean;
}

export function createRendererSuspendPort(
  options: SuspendPortOptions,
): ClassicSuspendPort {
  const { control, session } = options;
  let suspended = false;

  return {
    get suspended() {
      return suspended;
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      control.unmount();
      session.detachInput();
      session.leave();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      session.enter();
      session.attachInput();
      control.mount();
    },
    writeScrollback(text: string) {
      session.write(text);
    },
  };
}
