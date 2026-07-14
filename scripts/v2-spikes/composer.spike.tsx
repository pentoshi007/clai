/** @jsxImportSource @opentui/react */
// Phase 4 composer spike (V2-040..047).
//
// The composer's editing keys, submit/newline override, history recall, large
// paste, and slash-completion menu all depend on the real TextareaRenderable
// and the OpenTUI native key/paste pipeline, which only initializes under Bun
// (see ADR-007). This drives the real composer through simulated keys/paste in
// the headless test renderer and asserts observable behavior end to end.
//
// Run: bun run scripts/v2-spikes/composer.spike.tsx
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
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

const prompts: string[] = [];
const recordingAgent: AgentPort = {
  async runTurn(request: RunTurnRequest, _h: RunTurnHandlers): Promise<string> {
    prompts.push(request.prompt);
    return "ok";
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
    agent: recordingAgent,
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

export async function runComposerSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-040", "Composer editing, submit, history, paste, completion");
  const services = buildServices();
  const node = createElement(ServicesProvider, { services, children: createElement(App) });
  const setup = await testRender(node, { width: 120, height: 40, kittyKeyboard: true });
  const keys = setup.mockInput;

  try {
    await setup.flush();

    await keys.typeText("hello world");
    await setup.flush();
    check(result, "typed text appears in the frame", setup.captureCharFrame().includes("hello world"));

    keys.pressEnter();
    await setup.flush();
    await wait(50);
    check(result, "plain Enter submits the prompt", prompts[0] === "hello world");
    check(result, "composer clears after submit", !setup.captureCharFrame().includes("hello world"));

    await keys.typeText("line one");
    keys.pressEnter({ shift: true });
    await setup.flush();
    check(result, "shift+enter did not submit", prompts.length === 1);
    await keys.typeText("line two");
    keys.pressEnter();
    await setup.flush();
    await wait(50);
    check(
      result,
      "shift+enter inserted a real newline before the second submit",
      prompts[1] === "line one\nline two",
    );

    keys.pressKey("j", { ctrl: true });
    await setup.flush();
    check(result, "ctrl+j did not submit or insert a newline", prompts.length === 2);
    check(result, "ctrl+j left the composer empty (jobs owns it, not newline)", !setup.captureCharFrame().includes("line one"));

    await keys.typeText("to be cleared");
    await setup.flush();
    keys.pressKey("u", { ctrl: true });
    await setup.flush();
    check(result, "ctrl+u cleared the composer", !setup.captureCharFrame().includes("to be cleared"));

    keys.pressArrow("up");
    await setup.flush();
    check(
      result,
      "up at an empty buffer recalls the most recent history entry",
      setup.captureCharFrame().includes("line one"),
    );
    keys.pressArrow("up");
    await setup.flush();
    check(
      result,
      "up again moves the cursor within the recalled multiline entry first (INPUT-006)",
      setup.captureCharFrame().includes("line one"),
    );
    keys.pressArrow("up");
    await setup.flush();
    check(
      result,
      "up from the top line of the recalled entry now recalls the older entry",
      setup.captureCharFrame().includes("hello world"),
    );
    keys.pressArrow("down");
    await setup.flush();
    check(result, "down returns to the newer history entry", setup.captureCharFrame().includes("line one"));

    keys.pressKey("u", { ctrl: true });
    await setup.flush();

    const bigPaste = Array.from({ length: 20 }, (_, i) => `pasted line ${i}`).join("\n");
    await keys.pasteBracketedText(bigPaste);
    await setup.flush();
    const pastedFrame = setup.captureCharFrame();
    check(result, "large paste collapses to a placeholder", pastedFrame.includes("Pasted text"));
    check(result, "large paste does not inline all 20 lines", !pastedFrame.includes("pasted line 19"));

    keys.pressKey("u", { ctrl: true });
    await setup.flush();

    await keys.typeText("/mod");
    await setup.flush();
    check(result, "typing a slash command shows a completion menu", setup.captureCharFrame().includes("/model"));
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
  const r = await runComposerSpike();
  printResult(r);
  console.log(`\n${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
  process.exit(r.passed ? 0 : 1);
}
