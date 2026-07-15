/** @jsxImportSource @opentui/react */
// Phase 5 transcript render spike (V2-050..057).
//
// Streaming Markdown, the ScrollBox, and real keyboard chords only behave
// correctly under the native OpenTUI renderer (Bun-only FFI, see ADR-007).
// This drives a scripted AgentEvent stream through the real App + composer
// submit path and asserts the transcript renders each item kind, honors the
// thinking/output visibility defaults, and responds to Ctrl+T/Ctrl+O/Ctrl+F.
//
// Run: bun run scripts/v2-spikes/transcript-render.spike.tsx
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { AgentEvent } from "../../src/agent/events.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createCompositionRoot } from "../../src/tui-v2/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/tui-v2/bootstrap/capabilities.js";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/tui-v2/app/providers.js";
import { check, makeResult, printResult, type SpikeResult } from "./harness.js";

const scriptedEvents: AgentEvent[] = [
  { type: "turn-start", prompt: "list the repo files" },
  { type: "thinking-delta", text: "I should run " },
  { type: "thinking-delta", text: "fs.list on the repo root." },
  { type: "thinking-block", content: "I should run fs.list on the repo root." },
  { type: "tool-call", id: "c1", name: "fs.list", argsDisplay: "." },
  ...Array.from({ length: 8 }, (_, i) => ({
    type: "tool-output" as const,
    id: "c1",
    chunk: `entry-${i}.ts\n`,
  })),
  {
    type: "tool-result",
    id: "c1",
    ok: true,
    exitCode: 0,
    summary: "8 entries",
    artifactPath: "/tmp/clai-spike-output.txt",
  },
  { type: "assistant-delta", text: "Here are the **files**.\n" },
  { type: "assistant-message", text: "Here are the **files**." },
  { type: "turn-end", finalAnswer: "Here are the files.", steps: 1 },
];

const scriptedAgent: AgentPort = {
  async runTurn(_request: RunTurnRequest, handlers: RunTurnHandlers): Promise<string> {
    for (let index = 0; index < scriptedEvents.length; index += 1) {
      handlers.onEvent(scriptedEvents[index]!);
      if (index === 1) await wait(100);
    }
    return "Here are the files.";
  },
};

const noopPersistence: PersistencePort = {
  async saveSession() {},
  async loadPlan() {
    return undefined;
  },
  async savePlan() {},
  async deletePlan() {},
};

function buildServices() {
  return createCompositionRoot({
    agent: scriptedAgent,
    persistence: noopPersistence,
    provider: "groq",
    model: "demo-model",
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTranscriptRenderSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-050", "Transcript rendering, expand toggles, search");
  const services = buildServices();
  const node = createElement(ServicesProvider, { services, children: createElement(App) });
  const setup = await testRender(node, { width: 120, height: 40, kittyKeyboard: true });
  const keys = setup.mockInput;

  try {
    await setup.flush();
    await keys.typeText("list the repo files");
    keys.pressEnter();
    await wait(20);
    await setup.flush();
    const hiddenLiveThinking = setup.captureCharFrame();
    check(result, "thinking stays hidden while disabled", !hiddenLiveThinking.includes("I should run"));

    keys.pressKey("t", { ctrl: true });
    await setup.flush();
    check(result, "ctrl+t reveals live thinking", setup.captureCharFrame().includes("I should run"));

    await wait(120);
    await setup.flush();

    const frame = setup.captureCharFrame();
    check(result, "user message rendered", frame.includes("list the repo files"));
    check(result, "assistant markdown rendered (bold marker consumed)", frame.includes("files") && !frame.includes("**files**"));
    check(result, "tool card rendered with status", frame.includes("fs.list") && frame.includes("done (exit 0)"));
    check(result, "tool artifact path rendered as a link/path affordance", frame.includes("/tmp/clai-spike-output.txt"));
    check(result, "tool output collapsed by default (last chunk visible)", frame.includes("entry-7.ts"));
    check(result, "tool output collapsed hides earlier lines", !frame.includes("entry-0.ts"));
    check(result, "completed thinking stays visible when enabled", frame.includes("I should run fs.list"));

    keys.pressKey("t", { ctrl: true });
    await setup.flush();
    const afterThinking = setup.captureCharFrame();
    check(result, "ctrl+t hides completed thinking", !afterThinking.includes("I should run fs.list"));

    keys.pressKey("o", { ctrl: true });
    await setup.flush();
    const afterOutput = setup.captureCharFrame();
    check(result, "ctrl+o expands tool output (earlier lines now visible)", afterOutput.includes("entry-0.ts"));

    keys.pressKey("r", { ctrl: true });
    await setup.flush();
    await wait(50);
    await setup.flush();
    check(result, "ctrl+r opens the search bar", setup.captureCharFrame().includes("Search:"));
    await keys.typeText("files");
    await setup.flush();
    await wait(50);
    await setup.flush();
    const searchFrame = setup.captureCharFrame();
    check(result, "search reports at least one match", /\d+\/\d+/.test(searchFrame));

    keys.pressEscape();
    await setup.flush();
    await wait(50);
    await setup.flush();
    check(result, "escape closes the search bar", !setup.captureCharFrame().includes("Search:"));
  } finally {
    let threw = false;
    try {
      setup.renderer.destroy();
      services.dispose();
    } catch (err) {
      threw = true;
      result.notes.push(`teardown threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    check(result, "renderer teardown did not throw", !threw);
  }
  return result;
}

if (import.meta.main) {
  const r = await runTranscriptRenderSpike();
  printResult(r);
  console.log(`\n${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
  process.exit(r.passed ? 0 : 1);
}
