import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { AgentEventAdapter } from "../../../src/app/adapters/agent-event-adapter.js";
import { EventSequencer, createCountingIdFactory } from "../../../src/app/events/sequencer.js";
import { asTurnId } from "../../../src/app/events/app-event.js";
import { transcriptItems } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(() => {
  ui?.unmount(); ui?.cleanup(); harness?.dispose();
  ui = undefined; harness = undefined;
});

it.each([40, 80, 120])("renders pending calls in classic at %i columns and upgrades the same card", async columns => {
  const h = createHarness({ columns, rows: 30 });
  harness = h;
  const adapter = new AgentEventAdapter(new EventSequencer(h.services.session.sessionId, createCountingIdFactory()), h.services.session.spool, h.emit);
  adapter.setTurn(asTurnId("pending"));
  ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
  adapter.ingest({ type: "turn-start", prompt: "inspect" });
  adapter.ingest({ type: "thinking-delta", text: "Planning the command" });
  adapter.ingest({ type: "tool-call-pending", id: "call-1", name: "shell.exec" });
  const tools = () => transcriptItems(h.services.transcript.getState()).filter(item => item.kind === "tool");
  const id = tools()[0]!.id;
  await vi.waitFor(() => {
    expect(ui!.lastFrame()).toContain("pending");
    expect(ui!.lastFrame()).toContain("receiving arguments");
    expect(ui!.lastFrame()).not.toContain("printf ready");
  });
  expect(transcriptItems(h.services.transcript.getState()).find(item => item.kind === "thinking")).toMatchObject({ streaming: false });
  adapter.ingest({ type: "tool-call", id: "call-1", name: "shell.exec", argsDisplay: "printf ready" });
  await vi.waitFor(() => {
    expect(ui!.lastFrame()).toContain("printf ready");
    expect(ui!.lastFrame()).not.toContain("receiving arguments");
  });
  adapter.ingest({ type: "tool-start", id: "call-1" });
  adapter.ingest({ type: "tool-output", id: "call-1", chunk: "ready" });
  adapter.ingest({ type: "tool-result", id: "call-1", ok: true, summary: "ready" });
  await vi.waitFor(() => expect(ui!.lastFrame()).toContain("ready"));
  expect(tools()).toHaveLength(1);
  expect(tools()[0]).toMatchObject({ id, status: "ok", pending: false });
});
