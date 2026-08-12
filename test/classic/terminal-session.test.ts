import { describe, expect, it } from "vitest";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  CLEAR_SCREEN,
  CLEAR_SCREEN_ONLY,
  CURSOR_HIDE,
  CURSOR_HOME,
  CURSOR_SHOW,
  MOUSE_OFF,
  MOUSE_ON,
  createTerminalSession,
} from "../../src/classic/bootstrap/terminal-session.js";
import { createRendererSuspendPort } from "../../src/classic/bootstrap/suspend-port.js";
import {
  createOsc52Renderer,
  osc52Sequence,
} from "../../src/classic/bootstrap/osc52-renderer.js";

function fakes(overrides: { isTTY?: boolean } = {}) {
  const writes: string[] = [];
  const rawModeCalls: boolean[] = [];
  const listeners = new Set<(chunk: string | Buffer) => void>();
  const stdout = {
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
  const stdin = {
    isTTY: overrides.isTTY ?? true,
    setRawMode(mode: boolean) {
      rawModeCalls.push(mode);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: string | Buffer) => void) {
      listeners.add(listener);
    },
    off(_event: "data", listener: (chunk: string | Buffer) => void) {
      listeners.delete(listener);
    },
  };
  return { writes, rawModeCalls, listeners, stdout, stdin };
}

describe("terminal session", () => {
  it("owns a fresh alternate screen", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: true });
    session.enter();
    session.leave();
    expect(f.writes).toContain(ALT_SCREEN_ON);
    expect(f.writes).toContain(ALT_SCREEN_OFF);
  });

  it("emits the documented enter sequences", () => {
    const f = fakes();
    createTerminalSession({ ...f, mouse: false }).enter();
    expect(f.writes).toEqual([
      ALT_SCREEN_ON,
      CLEAR_SCREEN_ONLY,
      CURSOR_HOME,
      BRACKETED_PASTE_ON,
      CURSOR_HIDE,
    ]);
  });

  it("enables mouse reporting only when asked", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: true });
    session.enter();
    expect(f.writes).toEqual([
      ALT_SCREEN_ON,
      CLEAR_SCREEN_ONLY,
      CURSOR_HOME,
      BRACKETED_PASTE_ON,
      CURSOR_HIDE,
      MOUSE_ON,
    ]);
    session.leave();
    expect(f.writes.slice(6)).toEqual([
      MOUSE_OFF,
      CURSOR_SHOW,
      BRACKETED_PASTE_OFF,
      ALT_SCREEN_OFF,
    ]);
  });

  it("enables mouse reporting by default and honours the environment", () => {
    const f = fakes();
    const def = createTerminalSession({ ...f, env: {} });
    const on = createTerminalSession({ ...f, env: { CLAI_CLASSIC_MOUSE: "1" } });
    const off = createTerminalSession({ ...f, env: { CLAI_CLASSIC_MOUSE: "0" } });
    const dumb = createTerminalSession({ ...f, env: { TERM: "dumb" } });
    const notty = createTerminalSession({ ...fakes({ isTTY: false }), env: {} });
    expect(def.mouseEnabled).toBe(true);
    expect(on.mouseEnabled).toBe(true);
    expect(off.mouseEnabled).toBe(false);
    expect(dumb.mouseEnabled).toBe(false);
    expect(notty.mouseEnabled).toBe(false);
  });

  it("leaves in reverse order", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    session.enter();
    f.writes.length = 0;
    session.leave();
    expect(f.writes).toEqual([CURSOR_SHOW, BRACKETED_PASTE_OFF, ALT_SCREEN_OFF]);
  });

  it("is idempotent for enter and leave", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    session.enter();
    session.enter();
    session.leave();
    session.leave();
    expect(f.writes.filter((w) => w === BRACKETED_PASTE_ON)).toHaveLength(1);
    expect(f.writes.filter((w) => w === CURSOR_SHOW)).toHaveLength(1);
    expect(session.entered).toBe(false);
  });

  it("is idempotent for attachInput and detachInput", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    const seen: string[] = [];
    session.attachInput((chunk) => seen.push(chunk));
    session.attachInput((chunk) => seen.push(`dup:${chunk}`));
    expect(f.listeners.size).toBe(1);
    for (const listener of f.listeners) listener(Buffer.from("ab", "utf8"));
    expect(seen).toEqual(["ab"]);
    session.detachInput();
    session.detachInput();
    expect(f.listeners.size).toBe(0);
    expect(f.rawModeCalls).toEqual([true, false]);
  });

  it("reattaches the remembered handler without a new one", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    const seen: string[] = [];
    session.attachInput((chunk) => seen.push(chunk));
    session.detachInput();
    session.attachInput();
    expect(session.inputAttached).toBe(true);
    for (const listener of f.listeners) listener("z");
    expect(seen).toEqual(["z"]);
  });

  it("skips raw mode on a non-TTY stdin", () => {
    const f = fakes({ isTTY: false });
    const session = createTerminalSession({ ...f, mouse: false });
    session.attachInput(() => {});
    session.detachInput();
    expect(f.rawModeCalls).toEqual([]);
  });

  it("survives a stdout that throws during teardown", () => {
    const failing = {
      write() {
        throw new Error("EPIPE");
      },
    };
    const session = createTerminalSession({
      stdout: failing,
      stdin: fakes().stdin,
      mouse: true,
    });
    expect(() => {
      session.enter();
      session.leave();
    }).not.toThrow();
    expect(session.entered).toBe(false);
  });

  it("clears the screen only when asked", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    session.enter();
    expect(f.writes).not.toContain(CLEAR_SCREEN);
    session.clearScreen();
    expect(f.writes.at(-1)).toBe(CLEAR_SCREEN);
  });
});

describe("renderer suspend port", () => {
  it("unmounts and releases the terminal on suspend, restoring it on resume", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    const order: string[] = [];
    const control = {
      mount: () => order.push("mount"),
      unmount: () => order.push("unmount"),
    };
    const port = createRendererSuspendPort({ control, session });
    session.enter();
    session.attachInput(() => {});
    f.writes.length = 0;

    port.suspend();
    expect(order).toEqual(["unmount"]);
    expect(session.entered).toBe(false);
    expect(session.inputAttached).toBe(false);
    expect(f.writes).toEqual([CURSOR_SHOW, BRACKETED_PASTE_OFF, ALT_SCREEN_OFF]);

    port.writeScrollback("exported\n");
    expect(f.writes.at(-1)).toBe("exported\n");

    port.resume();
    expect(order).toEqual(["unmount", "mount"]);
    expect(session.entered).toBe(true);
    expect(session.inputAttached).toBe(true);
  });

  it("is idempotent in both directions", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    let mounts = 0;
    let unmounts = 0;
    const port = createRendererSuspendPort({
      control: { mount: () => (mounts += 1), unmount: () => (unmounts += 1) },
      session,
    });
    port.resume();
    port.suspend();
    port.suspend();
    port.resume();
    port.resume();
    expect(unmounts).toBe(1);
    expect(mounts).toBe(1);
    expect(port.suspended).toBe(false);
  });
});

describe("OSC 52 renderer", () => {
  it("writes the clipboard payload through the terminal session", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    const renderer = createOsc52Renderer({ session, supported: true, env: {} });
    expect(renderer.isOsc52Supported()).toBe(true);
    expect(renderer.copyToClipboardOSC52("hi")).toBe(true);
    expect(f.writes).toEqual([`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`]);
  });

  it("refuses to write when unsupported", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    const renderer = createOsc52Renderer({ session, supported: false, env: {} });
    expect(renderer.copyToClipboardOSC52("hi")).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it("wraps the sequence for tmux and screen", () => {
    const payload = Buffer.from("x").toString("base64");
    expect(osc52Sequence("x", "none")).toBe(`\x1b]52;c;${payload}\x07`);
    expect(osc52Sequence("x", "tmux")).toBe(
      `\x1bPtmux;\x1b\x1b]52;c;${payload}\x07\x1b\\`,
    );
    expect(osc52Sequence("x", "screen")).toBe(`\x1bP\x1b]52;c;${payload}\x07\x1b\\`);
  });

  it("selects the multiplexer passthrough from the environment", () => {
    const f = fakes();
    const session = createTerminalSession({ ...f, mouse: false });
    createOsc52Renderer({
      session,
      supported: true,
      env: { TMUX: "/tmp/tmux-0/default" },
    }).copyToClipboardOSC52("x");
    expect(f.writes[0]).toContain("\x1bPtmux;");
  });
});
