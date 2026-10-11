import assert from "node:assert/strict";
import { act, createElement, useEffect, useRef } from "react";
import { KeyEvent, type ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { EMPTY_TRANSCRIPT_STATE, type ToolItem, type TranscriptState } from "../../src/ui-core/state/transcript-types.js";
import { extractTranscriptSemanticDocument } from "../../src/ui-core/rendering/transcript-semantic.js";
import { useTranscriptSelection, type TranscriptSelectionBinding } from "../../src/tui-v2/components/transcript/use-transcript-selection.js";

interface HarnessProps {
  services: AppServices;
  state: TranscriptState;
  binding: { current: TranscriptSelectionBinding | undefined };
}

function Harness({ services, state, binding }: HarnessProps) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const selection = useTranscriptSelection({ services, state, spool: services.session.spool, scrollRef, focused: true, sessionId: "selection-fixture" });
  useEffect(() => { binding.current = selection; });
  return createElement("text", {}, "Terminal selection fixture");
}

function key(name: string, shift = false): KeyEvent {
  return new KeyEvent({ name, ctrl: true, shift, meta: false, option: false, number: false, sequence: name, raw: name, eventType: "press", source: "raw" });
}

for (const deferred of [true, false]) {
  let copied = "";
  let loads = 0;
  const services = createCompositionRoot({
    noHistory: true,
    clipboard: { async writeText(text) { copied = text; } },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 80, rows: 24 }),
  });
  const body = Array.from({ length: 14 }, (_, index) => `  output-${index}`).join("\n");
  const framed = `[terminal.send] seq=1 delivery=delivered state=running\n[terminal.output cursor=0 nextCursor=50 earliestAvailableCursor=0 latestCursor=50 hasMore=false view=plain]\nmsf6 > help\n${body}\ngsk_fixtureToken\nmsf6 > \n[/terminal.output]`;
  const item: ToolItem = {
    id: "terminal-copy", sequence: 1, turnId: asTurnId("turn-copy"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-copy"),
    name: "terminal.send", argsDisplay: 'id=its_demo kind=text text="help"', status: "ok", exitCode: undefined,
    summary: "terminal.send completed", artifactPath: "/tmp/terminal-copy-fixture.txt", reason: undefined, outputBytes: framed.length, fileChanges: undefined,
  };
  const state: TranscriptState = { ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) };
  if (deferred) services.session.spool.defer(item.toolCallId, () => { loads += 1; return framed; });
  else services.session.spool.replace(item.toolCallId, framed);
  services.focus.focusRegion("transcript");
  const binding = { current: undefined as TranscriptSelectionBinding | undefined };
  const setup = await testRender(createElement(Harness, { services, state, binding }), { width: 80, height: 24, useThread: false });
  try {
    await act(async () => { await setup.flush(); });
    assert.ok(binding.current);
    await act(async () => { assert.equal(binding.current!.handleKey(key("a"), "ctrl+a"), true); });
    assert.ok(services.selection.hasSelection());
    await act(async () => { assert.equal(binding.current!.handleKey(key("c", true), "ctrl+shift+c"), true); await setup.flush(); });
    assert.ok(copied.includes('text="help"'), copied);
    assert.ok(copied.includes("msf6 > help"), copied);
    for (let index = 0; index < 14; index += 1) assert.ok(copied.includes(`  output-${index}`), copied);
    assert.ok(copied.includes("nextCursor=50"), copied);
    assert.ok(copied.includes("delivery=delivered"), copied);
    assert.ok(copied.includes("gsk_••••••"), copied);
    assert.ok(!copied.includes("fixtureToken"), copied);
    assert.ok(!copied.includes("[/terminal.output]"), copied);
    assert.equal(loads, deferred ? 1 : 0);
    const v2Text = copied;
    services.selection.setDocument("transcript", extractTranscriptSemanticDocument(state, { thinking: "all", toolOutput: tool => services.session.spool.tail(tool.toolCallId) }));
    services.selection.selectAll("transcript");
    await services.selection.copy();
    assert.equal(copied, v2Text);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native terminal selection passed: deferred/live output, collapsed select-all, full body, redaction and classic parity");
