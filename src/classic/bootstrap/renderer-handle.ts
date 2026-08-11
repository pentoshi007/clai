import type { RendererHandle } from "../../ui-core/bootstrap/lifecycle.js";
import type { InkMountControl } from "./suspend-port.js";
import type { TerminalDataListener, TerminalSession } from "./terminal-session.js";

export type ClassicTerminalSession = Pick<
  TerminalSession,
  "enter" | "leave" | "attachInput" | "detachInput"
>;

export interface ClassicRendererParts {
  readonly session: ClassicTerminalSession;
  readonly control: InkMountControl;
  readonly onData: TerminalDataListener;
  readonly disposeServices: () => void;
}

export interface ClassicRenderer {
  readonly handle: RendererHandle;
  readonly done: Promise<void>;
}

export function createClassicRenderer(parts: ClassicRendererParts): ClassicRenderer {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handle: RendererHandle = {
    start() {
      parts.session.enter();
      parts.session.attachInput(parts.onData);
      parts.control.mount();
    },
    destroy() {
      parts.control.unmount();
      parts.session.detachInput();
      parts.session.leave();
      parts.disposeServices();
      resolveDone();
    },
  };

  return { handle, done };
}
