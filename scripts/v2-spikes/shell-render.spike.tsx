/** @jsxImportSource @opentui/react */
// Phase 3 shell render + teardown spike (V2-030/032; V2-035 substitute).
//
// PTY snapshot tests (V2-035) need a live terminal, which this non-interactive,
// single-OS environment cannot provide. Instead this mounts the real empty v2
// shell in OpenTUI's headless React test renderer (Bun-only native FFI) and
// asserts:
//   - the shell renders a well-formed, non-blank frame at compact/single/wide
//     dimensions with the expected chrome per the layout engine;
//   - resize keeps the frame well-formed (startup/resize behavior);
//   - renderer teardown runs without throwing (never corrupts the terminal).
//
// Run: bun run scripts/v2-spikes/shell-render.spike.tsx
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
import { check, makeResult, measure, type SpikeResult } from "./harness.js";

const idleAgent: AgentPort = {
  async runTurn(_r: RunTurnRequest, _h: RunTurnHandlers): Promise<string> {
    return "";
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
    agent: idleAgent,
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

function compact(frame: string): string {
  return frame.replace(/\s+/g, "");
}

export async function runShellRenderSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-032", "Empty v2 shell render + resize + teardown");
  const services = buildServices();
  const node = createElement(
    ServicesProvider,
    { services, children: createElement(App) },
  );

  const setup = await testRender(node, { width: 120, height: 40 });
  try {
    await setup.flush();
    const wide = setup.captureCharFrame();
    check(result, "wide frame is non-blank", compact(wide).length > 0);
    check(result, "wide frame has no status strip", !/^clai ·/m.test(wide));
    check(result, "wide frame has no Chat chrome title", !wide.includes("Chat"));
    check(result, "wide frame has no Composer chrome title", !wide.includes("Composer"));
    check(result, "wide frame shows intro model card", wide.includes("model"));
    check(result, "wide frame shows intro welcome", wide.includes("Welcome to clai"));
    check(result, "wide frame shows mode badge", wide.includes("AGENT MODE"));
    check(result, "wide frame shows provider on intro card", wide.includes("groq"));
    check(result, "wide frame no longer shows empty placeholder", !wide.includes("No messages yet"));
    check(
      result,
      "wide frame height matches terminal",
      wide.split("\n").length >= 40,
    );

    setup.resize(90, 30);
    await setup.flush();
    const single = setup.captureCharFrame();
    check(result, "single-column frame non-blank after resize", compact(single).length > 0);
    check(result, "single-column has no status strip", !/^clai ·/m.test(single));
    check(result, "single-column intro still shows provider", single.includes("groq"));

    setup.resize(70, 16);
    await setup.flush();
    const comp = setup.captureCharFrame();
    check(result, "compact frame non-blank after resize", compact(comp).length > 0);
    check(
      result,
      "no raw ESC byte leaked into any frame",
      !wide.includes("\u001b") && !single.includes("\u001b") && !comp.includes("\u001b"),
    );

    measure(result, "wideLines", wide.split("\n").length);
    measure(result, "singleLines", single.split("\n").length);
    measure(result, "compactLines", comp.split("\n").length);
  } finally {
    let threw = false;
    try {
      setup.renderer.destroy();
      services.dispose();
    } catch (err) {
      threw = true;
      result.notes.push(
        `teardown threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    check(result, "renderer teardown did not throw", !threw);
  }
  return result;
}

if (import.meta.main) {
  const { printResult } = await import("./harness.js");
  const r = await runShellRenderSpike();
  printResult(r);
  console.log(`\n${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
  process.exit(r.passed ? 0 : 1);
}
