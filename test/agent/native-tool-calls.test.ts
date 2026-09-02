import { describe, expect, it } from "vitest";
import type { NativeToolCall } from "../../src/types.js";
import type { StreamDeferredToolCall } from "../../src/agent/turn/loop/stream-session.js";
import {
  firstNativeToolCall,
  syncNativeToolCallCards,
  type NativeCardPorts,
} from "../../src/agent/turn/loop/native-tool-calls.js";

const harness = (deferred: StreamDeferredToolCall[] = []) => {
  const printed: string[] = [];
  let counter = 0;
  const ports: NativeCardPorts = {
    deferredToolCalls: deferred,
    callIds: [],
    allocateEventId: () => `tool-${++counter}`,
    markPrinted: (eventId) => printed.push(eventId),
  };
  return { ports, printed };
};

const native = (name: string, args: Record<string, unknown> = {}): NativeToolCall =>
  ({ name, args }) as NativeToolCall;

describe("native tool call cards", () => {
  it("does nothing without native calls", () => {
    const h = harness();
    syncNativeToolCallCards(h.ports, []);
    expect(h.ports.deferredToolCalls).toEqual([]);
    expect(h.ports.callIds).toEqual([]);
  });

  it("creates unshown cards when the stream opened none", () => {
    const h = harness();
    syncNativeToolCallCards(h.ports, [native("fs.read"), native("fs.list")]);
    expect(h.ports.deferredToolCalls).toHaveLength(2);
    expect(h.ports.deferredToolCalls[0]!.shown).toBe(false);
    expect(h.ports.callIds).toEqual(["tool-1", "tool-2"]);
    expect(h.printed).toEqual(["tool-1", "tool-2"]);
  });

  it("refreshes arguments on cards the stream already opened", () => {
    const existing: StreamDeferredToolCall[] = [
      { eventId: "tool-9", call: { name: "fs.read", args: {} }, shown: true },
    ];
    const h = harness(existing);
    syncNativeToolCallCards(h.ports, [native("fs.read", { path: "a.ts" })]);
    expect(h.ports.deferredToolCalls).toHaveLength(1);
    expect(h.ports.deferredToolCalls[0]!.eventId).toBe("tool-9");
    expect(h.ports.deferredToolCalls[0]!.call.args).toEqual({ path: "a.ts" });
    expect(h.ports.callIds).toEqual(["tool-9"]);
    expect(h.printed).toEqual([]);
  });

  it("replaces a placeholder card and keeps its event id and shown flag", () => {
    const existing: StreamDeferredToolCall[] = [
      { eventId: "tool-7", call: { name: "…", args: {} }, shown: true },
    ];
    const h = harness(existing);
    syncNativeToolCallCards(h.ports, [native("fs.write", { path: "a.ts" })]);
    expect(h.ports.deferredToolCalls[0]).toEqual({
      eventId: "tool-7",
      call: { name: "fs.write", args: { path: "a.ts" } },
      shown: true,
    });
    expect(h.printed).toEqual(["tool-7"]);
  });

  it("appends cards for native calls beyond the streamed ones", () => {
    const existing: StreamDeferredToolCall[] = [
      { eventId: "tool-1", call: { name: "fs.read", args: {} }, shown: true },
    ];
    const h = harness(existing);
    syncNativeToolCallCards(h.ports, [native("fs.read"), native("fs.list")]);
    expect(h.ports.deferredToolCalls).toHaveLength(2);
    expect(h.ports.deferredToolCalls[1]!.shown).toBe(false);
  });

  it("selects the first native call", () => {
    expect(firstNativeToolCall([native("fs.read", { path: "a" })])).toEqual({
      name: "fs.read",
      args: { path: "a" },
    });
  });

  it("returns undefined with no native calls", () => {
    expect(firstNativeToolCall([])).toBeUndefined();
  });

  it("surfaces a native parse error as an invalid call", () => {
    expect(
      firstNativeToolCall([
        native("fs.write", { _parseError: true, _raw: "{bad" }),
      ]),
    ).toEqual({
      name: "fs.write",
      args: { __nativeParseError: true, _raw: "{bad" },
    });
  });

  it("names an unnamed parse error call unknown", () => {
    expect(
      firstNativeToolCall([native("", { _parseError: true, _raw: "x" })]),
    ).toMatchObject({ name: "unknown" });
  });
});
