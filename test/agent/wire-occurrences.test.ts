import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/types.js";
import { createWireOccurrenceLedger } from "../../src/agent/turn/loop/wire-occurrences.js";

function ledger() {
  let epoch = 0;
  const instance = createWireOccurrenceLedger({
    isPrinted: () => true,
    writeToolCall: () => undefined,
    markPrinted: () => undefined,
    emitToolStart: () => undefined,
    writeToolOutput: () => undefined,
    emitToolResult: () => undefined,
    signature: (call) => `${call.name}::${JSON.stringify(call.args)}`,
    changeEpoch: () => epoch,
  });
  const execute = (wireId: string, call: ToolCall, output: string) =>
    instance.remember(wireId, call, {
      call,
      result: { ok: true, output },
      contextOutput: output,
      ok: true,
    });
  return {
    instance,
    execute,
    changeState: () => {
      epoch += 1;
    },
  };
}

const runScript: ToolCall = { name: "shell.exec", args: { command: "node script.js" } };
const editScript: ToolCall = {
  name: "fs.edit",
  args: { path: "script.js", oldText: "a", newText: "b" },
};

describe("wire occurrence replay", () => {
  it("replays a re-emitted provider call when nothing changed", () => {
    const { instance, execute } = ledger();
    execute("call_1", runScript, "output");
    instance.settleRound();
    expect(instance.replay("call_1", runScript, "event-2")?.contextOutput).toContain("output");
  });

  it("runs a different call that reuses a provider call id", () => {
    const { instance, execute } = ledger();
    execute("call_0", runScript, "output");
    instance.settleRound();
    expect(instance.replay("call_0", editScript, "event-2")).toBeUndefined();
  });

  it("runs the same call again after state changed", () => {
    const { instance, execute, changeState } = ledger();
    execute("call_0", runScript, "output");
    instance.settleRound();
    changeState();
    expect(instance.replay("call_0", runScript, "event-2")).toBeUndefined();
  });

  it("replays an echoed batch whose later call changed state in the same round", () => {
    const { instance, execute, changeState } = ledger();
    execute("call_run", runScript, "output");
    changeState();
    execute("call_edit", editScript, "edited");
    instance.settleRound();
    expect(instance.replay("call_run", runScript, "event-3")).toBeDefined();
    expect(instance.replay("call_edit", editScript, "event-4")).toBeDefined();
  });

  it("replays the latest call that used a reused provider call id", () => {
    const { instance, execute, changeState } = ledger();
    execute("call_0", runScript, "first");
    instance.settleRound();
    changeState();
    execute("call_0", editScript, "edited");
    instance.settleRound();
    expect(instance.replay("call_0", runScript, "event-3")).toBeUndefined();
    expect(instance.replay("call_0", editScript, "event-4")?.contextOutput).toContain("edited");
  });
});
