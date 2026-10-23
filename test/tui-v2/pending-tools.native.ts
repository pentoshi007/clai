import assert from "node:assert/strict";
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
  try {
    await emit({ type: "turn-start", prompt: "inspect the project" });
    await emit({ type: "thinking-delta", text: "Planning the command" });
    const pending = await emit({ type: "tool-call-pending", id: "call-1", name: "shell.exec" });
    const itemId = tools()[0]!.id;
    assert.match(pending, /shell.exec/);
    assert.match(pending, /pending/);
    assert.match(pending, /receiving arguments/);
    assert.doesNotMatch(pending, /printf ready/);
    assert.ok(setup.renderer.root.findDescendantById(itemId));
    assert.equal(transcriptItems(services.transcript.getState()).find(item => item.kind === "thinking")?.streaming, false);
    const complete = await emit({ type: "tool-call", id: "call-1", name: "shell.exec", argsDisplay: "printf ready" });
    assert.match(complete, /printf ready/);
    assert.doesNotMatch(complete, /receiving arguments/);
    assert.equal(tools().length, 1);
    assert.equal(tools()[0]!.id, itemId);
    await emit({ type: "tool-start", id: "call-1" });
    await emit({ type: "tool-output", id: "call-1", chunk: "ready" });
    const result = await emit({ type: "tool-result", id: "call-1", ok: true, summary: "ready" });
    assert.equal(tools()[0]!.status, "ok");
    assert.match(result, /ready/);
    assert.equal(tools()[0]!.id, itemId);
    evidence.push(`${width} columns: pending\n${pending}\ncomplete\n${complete}\nresult\n${result}`);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
if (process.env.CLAI_PENDING_EVIDENCE) await writeFile(process.env.CLAI_PENDING_EVIDENCE, evidence.join("\n\n"));
console.log("Native pending tools passed: immediate skeleton, closed thinking, stable card, complete input and output");
