import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { TerminalSession } from "../../src/classic/bootstrap/terminal-session.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  CLEAR_SCREEN,
  CURSOR_HOME,
} from "../../src/classic/input/terminal-sequences.js";

class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  output(): string {
    return this.chunks.join("");
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  raw: boolean | undefined;
  resumed = false;
  setEncoding(): this {
    return this;
  }
  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.resumed = false;
    return this;
  }
}

describe("TerminalSession", () => {
  it("enters alt screen + paste and leaves in reverse, exactly once", () => {
    const out = new FakeStdout();
    const terminal = new TerminalSession({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    terminal.enter();
    terminal.enter();
    terminal.leave();
    terminal.leave();
    const text = out.output();
    expect(text.indexOf(ALT_SCREEN_ON)).toBe(0);
    expect(text).toContain(CLEAR_SCREEN + CURSOR_HOME);
    expect(text).toContain(BRACKETED_PASTE_ON);
    expect(text.endsWith(BRACKETED_PASTE_OFF + ALT_SCREEN_OFF)).toBe(true);
    expect(
      text.split(ALT_SCREEN_ON).length - 1,
    ).toBe(1);
  });

  it("attaches raw mode only when the input layer attaches", () => {
    const out = new FakeStdout();
    const stdin = new FakeStdin();
    const terminal = new TerminalSession({
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
    });
    terminal.enter();
    expect(stdin.raw).toBeUndefined();
    terminal.attachInput();
    expect(stdin.raw).toBe(true);
    expect(stdin.resumed).toBe(true);
    terminal.leave();
    expect(stdin.raw).toBe(false);
    expect(terminal.isOwned).toBe(false);
  });
});
