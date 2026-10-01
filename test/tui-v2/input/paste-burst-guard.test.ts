import { describe, expect, it } from "vitest";
import {
  installPasteBurstGuard,
  type GuardedKey,
  type GuardedKeyInput,
} from "../../../src/tui-v2/input/paste-burst-guard.js";
import {
  PASTE_BURST_GLUE_MS,
  PASTE_BURST_SETTLE_MS,
} from "../../../src/ui-core/input/paste-burst.js";

interface FakeKey extends GuardedKey {
  stopped: boolean;
}

function fakeKey(sequence: string, overrides: Partial<GuardedKey> = {}): FakeKey {
  const named = sequence === "\r" ? "return" : sequence === "\n" ? "linefeed" : sequence === "\t" ? "tab" : sequence;
  const key: FakeKey = {
    name: named,
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    eventType: "press",
    source: "raw",
    ...overrides,
    stopped: false,
    stopPropagation() {
      key.stopped = true;
    },
  };
  return key;
}

class FakeKeyInput implements GuardedKeyInput<FakeKey> {
  readonly keyListeners: Array<(key: FakeKey) => void> = [];
  readonly pasteListeners: Array<() => void> = [];
  readonly app: string[] = [];

  prependListener(event: "keypress", listener: (key: FakeKey) => void): unknown;
  prependListener(event: "paste", listener: () => void): unknown;
  prependListener(event: "keypress" | "paste", listener: ((key: FakeKey) => void) | (() => void)): unknown {
    if (event === "keypress") this.keyListeners.unshift(listener as (key: FakeKey) => void);
    else this.pasteListeners.unshift(listener as () => void);
    return this;
  }

  removeListener(event: "keypress", listener: (key: FakeKey) => void): unknown;
  removeListener(event: "paste", listener: () => void): unknown;
  removeListener(event: "keypress" | "paste", listener: ((key: FakeKey) => void) | (() => void)): unknown {
    const list = (event === "keypress" ? this.keyListeners : this.pasteListeners) as unknown[];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
    return this;
  }

  emitKey(key: FakeKey): void {
    for (const listener of [...this.keyListeners]) {
      listener(key);
      if (key.stopped) return;
    }
    this.app.push(`key:${key.eventType === "release" ? "release:" : ""}${JSON.stringify(key.sequence)}`);
  }

  emitPaste(text: string): void {
    for (const listener of [...this.pasteListeners]) listener();
    this.app.push(`paste:${JSON.stringify(text)}`);
  }

  processParsedKey(key: FakeKey): void {
    this.emitKey(fakeKey(key.sequence, { ...key }));
  }

  processPaste(bytes: Uint8Array): void {
    this.emitPaste(new TextDecoder().decode(bytes));
  }
}

interface Timer {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

function harness() {
  const input = new FakeKeyInput();
  const timers: Timer[] = [];
  const microtasks: Array<() => void> = [];
  let now = 0;
  const dispose = installPasteBurstGuard(input, {
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer: Timer = { at: now + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    defer: (callback) => microtasks.push(callback),
  });
  const runMicrotasks = (): void => {
    while (microtasks.length > 0) microtasks.shift()?.();
  };
  const advanceTo = (time: number): void => {
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= time)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      now = Math.max(now, due.at);
      due.callback();
      runMicrotasks();
    }
    now = Math.max(now, time);
  };
  const read = (text: string, at: number): void => {
    advanceTo(at);
    for (const char of text) input.emitKey(fakeKey(char));
    runMicrotasks();
  };
  return { input, read, advanceTo, runMicrotasks, dispose, microtasks };
}

describe("installPasteBurstGuard", () => {
  it("delivers typed keystrokes and Enter in order once the read finishes", () => {
    const { input, read } = harness();
    read("a", 0);
    expect(input.app).toEqual(['key:"a"']);
    read("\r", 500);
    expect(input.app).toEqual(['key:"a"', 'key:"\\r"']);
  });

  it("keeps a multi-line read away from the application and delivers one paste", () => {
    const { input, read, advanceTo } = harness();
    read("one\rtwo\r\rthree", 0);
    expect(input.app).toEqual([]);
    advanceTo(PASTE_BURST_SETTLE_MS - 1);
    expect(input.app).toEqual([]);
    advanceTo(PASTE_BURST_SETTLE_MS);
    expect(input.app).toEqual(['paste:"one\\ntwo\\n\\nthree"']);
  });

  it("keeps a paste whole when its lines arrive as separate, slow reads", () => {
    const { input, read, advanceTo } = harness();
    ["first line\r", "\r", "third line\r", "fourth"].forEach((piece, index) => read(piece, index * 120));
    advanceTo(10_000);
    expect(input.app).toEqual(['paste:"first line\\n\\nthird line\\nfourth"']);
  });

  it("keeps a paste whole when each Enter arrives ahead of its line", () => {
    const { input, read, advanceTo } = harness();
    ["first line", "\r", "\rsecond", "\rthird line"].forEach((piece, index) => read(piece, index * 100));
    advanceTo(10_000);
    const typed = input.app.filter((entry) => entry.startsWith("key:")).map((entry) => JSON.parse(entry.slice(4)));
    expect(typed.join("")).toBe("first line");
    expect(input.app.at(-1)).toBe('paste:"\\n\\nsecond\\nthird line"');
    expect(input.app).not.toContain('key:"\\r"');
  });

  it("accepts bare line feeds, tabs, uppercase and non-ASCII text as paste content", () => {
    const { input, read, advanceTo } = harness();
    read("Héllo\n\t世界\r!", 0);
    advanceTo(PASTE_BURST_SETTLE_MS);
    expect(input.app).toEqual(['paste:"Héllo\\n\\t世界\\n!"']);
  });

  it("holds a lone Enter after a multi-character read, then releases it as a keypress", () => {
    const { input, read, advanceTo } = harness();
    read("abc", 0);
    read("\r", PASTE_BURST_GLUE_MS + 1);
    expect(input.app).toEqual(['key:"a"', 'key:"b"', 'key:"c"']);
    advanceTo(PASTE_BURST_GLUE_MS + 1 + PASTE_BURST_SETTLE_MS);
    expect(input.app.at(-1)).toBe('key:"\\r"');
    expect(input.app).toHaveLength(4);
  });

  it("lets modified, navigation and escape keys through at once, behind pending text", () => {
    const { input, runMicrotasks } = harness();
    input.emitKey(fakeKey("a"));
    input.emitKey(fakeKey("b"));
    input.emitKey(fakeKey("c", { ctrl: true }));
    input.emitKey(fakeKey("\r", { meta: true }));
    input.emitKey(fakeKey("\u001b[A", { name: "up" }));
    input.emitKey(fakeKey("\u001b", { name: "escape" }));
    expect(input.app).toEqual([
      'key:"a"',
      'key:"b"',
      'key:"c"',
      'key:"\\r"',
      'key:"\\u001b[A"',
      'key:"\\u001b"',
    ]);
    runMicrotasks();
    expect(input.app).toHaveLength(6);
  });

  it("ignores key releases and kitty-encoded keys", () => {
    const { input } = harness();
    input.emitKey(fakeKey("\r", { eventType: "release" }));
    input.emitKey(fakeKey("\r", { source: "kitty" }));
    input.emitKey(fakeKey("\r", { shift: true }));
    expect(input.app).toEqual(['key:release:"\\r"', 'key:"\\r"', 'key:"\\r"']);
  });

  it("releases a collected paste before a following non-text key and keeps their order", () => {
    const { input, read } = harness();
    read("a\rb", 0);
    input.emitKey(fakeKey("\u001b[A", { name: "up" }));
    expect(input.app).toEqual(['paste:"a\\nb"', 'key:"\\u001b[A"']);
  });

  it("flushes pending keystrokes before a real paste event so order is kept", () => {
    const { input } = harness();
    input.emitKey(fakeKey("a"));
    input.emitKey(fakeKey("b"));
    input.emitPaste("xyz");
    expect(input.app).toEqual(['key:"a"', 'key:"b"', 'paste:"xyz"']);
  });

  it("does not intercept its own replayed keys and pastes", () => {
    const { input, read, advanceTo } = harness();
    read("x", 0);
    read("one\rtwo", 1_000);
    advanceTo(5_000);
    expect(input.app).toEqual(['key:"x"', 'paste:"one\\ntwo"']);
  });

  it("flushes everything pending on dispose, removes both listeners, and then stays out of the way", () => {
    const { input, read, dispose } = harness();
    read("one\rtwo", 0);
    expect(input.app).toEqual([]);
    dispose();
    expect(input.app).toEqual(['paste:"one\\ntwo"']);
    expect(input.keyListeners).toHaveLength(0);
    expect(input.pasteListeners).toHaveLength(0);
    input.emitKey(fakeKey("\r"));
    expect(input.app.at(-1)).toBe('key:"\\r"');
    dispose();
    expect(input.app).toHaveLength(2);
  });

  it("releases keys still waiting in a read when disposed mid-read", () => {
    const { input, dispose } = harness();
    input.emitKey(fakeKey("a"));
    input.emitKey(fakeKey("b"));
    dispose();
    expect(input.app).toEqual(['key:"a"', 'key:"b"']);
  });
});
