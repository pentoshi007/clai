import assert from "node:assert/strict";
import { spyOn } from "bun:test";
import { writeFile } from "node:fs/promises";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { AgentEventAdapter } from "../../src/app/adapters/agent-event-adapter.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asTurnId } from "../../src/app/events/app-event.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import type { AgentEvent } from "../../src/agent/events.js";

const evidence: string[] = [];
const intervals = spyOn(globalThis, "setInterval");
const clear = spyOn(globalThis, "clearInterval");
for (const width of [40, 80, 120]) {
  const services = createCompositionRoot({
    noHistory: true, mode: "agent",
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 30 }),
  });
  const adapter = new AgentEventAdapter(new EventSequencer(services.session.sessionId, createCountingIdFactory()), services.session.spool, event => services.transcript.dispatch(event));
  adapter.setTurn(asTurnId(`pending-${width}`));
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
    width, height: 30, useThread: false,
  });
  async function emit(event: AgentEvent): Promise<string> {
    await act(async () => { adapter.ingest(event); await new Promise(resolve => setTimeout(resolve, 25)); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame();
  }
  const tools = () => transcriptItems(services.transcript.getState()).filter(item => item.kind === "tool");
  async function waitFrame(): Promise<string> {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame();
  }
  async function pendingTimer(id: string): Promise<ReturnType<typeof setInterval>> {
    const start = intervals.mock.calls.length;
    await emit({ type: "tool-call-pending", id, name: "shell.exec" });
    const index = intervals.mock.calls.findIndex((args, position) => position >= start && args[1] === 1000);
    assert.ok(index >= start, "Pending card starts its animation timer");
    return intervals.mock.results[index]!.value;
  }
  let unmountTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await emit({ type: "turn-start", prompt: "inspect the project" });
    await emit({ type: "thinking-delta", text: "Planning the command" });
    const timer = await pendingTimer("call-1");
    const pending = setup.captureCharFrame();
    const itemId = tools()[0]!.id;
    assert.match(pending, /shell.exec/);
    assert.match(pending, /pending/);
    assert.equal(pending.match(/receiving arguments (\.+)/)?.[1], ".");
    if (width === 80) {
      const row = pending.split("\n").findIndex(line => line.includes("receiving arguments"));
      for (const dots of ["..", "...", "."]) {
        const frame = await waitFrame();
        assert.equal(frame.match(/receiving arguments (\.+)/)?.[1], dots);
        assert.equal(frame.split("\n").findIndex(line => line.includes("receiving arguments")), row);
        assert.equal(tools()[0]!.id, itemId);
        assert.ok(setup.renderer.root.findDescendantById(itemId));
        evidence.push(`80 columns: animation ${dots}\n${frame}`);
      }
    }
    assert.doesNotMatch(pending, /printf ready/);
    assert.ok(setup.renderer.root.findDescendantById(itemId));
    assert.equal(transcriptItems(services.transcript.getState()).find(item => item.kind === "thinking")?.streaming, false);
    const complete = await emit({ type: "tool-call", id: "call-1", name: "shell.exec", argsDisplay: "printf ready" });
    assert.match(complete, /printf ready/);
    assert.doesNotMatch(complete, /receiving arguments/);
    assert.ok(clear.mock.calls.some(([value]) => value === timer), "Completed arguments stop their animation timer");
    assert.equal(tools().length, 1);
    assert.equal(tools()[0]!.id, itemId);
    await emit({ type: "tool-start", id: "call-1" });
    await emit({ type: "tool-output", id: "call-1", chunk: "ready" });
    const result = await emit({ type: "tool-result", id: "call-1", ok: true, summary: "ready" });
    assert.equal(tools()[0]!.status, "ok");
    assert.match(result, /ready/);
    assert.equal(tools()[0]!.id, itemId);
    evidence.push(`${width} columns: pending\n${pending}\ncomplete\n${complete}\nresult\n${result}`);
    if (width === 80) {
      const blockedTimer = await pendingTimer("cancelled-call");
      const blocked = await emit({ type: "tool-blocked", id: "cancelled-call", name: "shell.exec", reason: "Cancelled before arguments completed" });
      assert.doesNotMatch(blocked, /receiving arguments/);
      assert.ok(clear.mock.calls.some(([value]) => value === blockedTimer), "Cancellation stops the animation timer");
      assert.doesNotMatch(await waitFrame(), /receiving arguments/);
      unmountTimer = await pendingTimer("unmounted-call");
    }
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
    if (unmountTimer !== undefined) {
      assert.ok(clear.mock.calls.some(([value]) => value === unmountTimer), "Unmount stops the animation timer");
    }
  }
}
if (process.env.CLAI_PENDING_EVIDENCE) await writeFile(process.env.CLAI_PENDING_EVIDENCE, evidence.join("\n\n"));
console.log("Native pending tools passed: immediate skeleton, closed thinking, stable card, complete input and output");
