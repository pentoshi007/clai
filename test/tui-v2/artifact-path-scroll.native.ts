import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";
import { patchOpenTuiWheelScroll } from "../../src/tui-v2/bootstrap/patch-opentui-wheel.js";

patchOpenTuiWheelScroll();

const artifactPath =
  "/var/folders/my/9y5r2wcj4q58b_z4dmj944xh0000gn/T/clai/61c5cf-20-10-2026-12-46-19/temp/2026-10-20T09-45-30-592Z-grep.txt";
const width = 100;
const height = 40;

async function flushAll(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  await act(async () => {
    await setup.flush();
  });
}

/** The artifact row must stay on one line, keep both ends, and never move. */
async function artifactRowSurvivesWheel(): Promise<void> {
  const services = createCompositionRoot({
    noHistory: true,
    persistence: {
      async saveSession() {},
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    },
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: width,
      rows: height,
    }),
  });
  const item: ToolItem = {
    id: "artifact-card",
    sequence: 1,
    turnId: asTurnId("turn-1"),
    timestamp: 0,
    kind: "tool",
    toolCallId: asToolCallId("call-artifact"),
    name: "shell.exec",
    argsDisplay: "grep -E 'svce|acct' /tmp/cmm_hook.log | head -20",
    status: "ok",
    exitCode: 0,
    summary: undefined,
    artifactPath,
    reason: undefined,
    outputBytes: 32,
    fileChanges: undefined,
  };
  services.session.spool.replace(item.toolCallId, "== total ==\n1");
  const setup = await testRender(
    createElement(ServicesProvider, {
      services,
      children: createElement(TerminalDimensionsContext.Provider, {
        value: { width, height },
        children: createElement(ToolCard, {
          item,
          theme: themeFor(services.capabilities.themeHint),
          spool: services.session.spool,
          expanded: false,
          services,
          onToggle() {},
          contentWidth: width - 4,
        }),
      }),
    }),
    { width, height, useThread: false },
  );
  try {
    await flushAll(setup);
    const rows = setup.captureCharFrame().split("\n");
    const index = rows.findIndex((row) => row.includes("592Z-grep"));
    assert.ok(index >= 0, rows.join("\n"));
    const before = rows[index]!;
    assert.ok(before.includes("/var/folders/my/"), `head is visible: ${before}`);
    assert.ok(before.includes("592Z-grep.txt"), `tail is visible: ${before}`);
    assert.ok(before.includes("…"), `middle-clipped on one row: ${before}`);
    assert.ok(before.trimEnd().endsWith("│"), `stays inside the card: ${before}`);

    await setup.mockMouse.scroll(10, index, "down");
    await flushAll(setup);
    const after = setup.captureCharFrame().split("\n");
    assert.equal(after[index], before, "wheel over the artifact row must not move it");
  } finally {
    await act(async () => {
      services.dispose();
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
  }
}

/** Root cause guard: a wrapping <text> clipped to one row ignores the wheel. */
async function clippedTextIgnoresWheel(): Promise<void> {
  const setup = await testRender(
    createElement(
      "box",
      { style: { width: 60, height: 3, border: true, flexDirection: "column" } },
      createElement(
        "box",
        { style: { width: 58, height: 1, overflow: "hidden" } },
        createElement("text", null, artifactPath),
      ),
    ),
    { width: 60, height: 3, useThread: false },
  );
  try {
    await flushAll(setup);
    const before = setup.captureCharFrame().split("\n")[1] ?? "";
    assert.ok(before.includes("/var/folders/my/"), `head is visible: ${before}`);
    await setup.mockMouse.scroll(5, 1, "down");
    await flushAll(setup);
    const after = setup.captureCharFrame().split("\n")[1] ?? "";
    assert.equal(after, before, "clipped text must not scroll itself under the pointer");
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
  }
}

await artifactRowSurvivesWheel();
await clippedTextIgnoresWheel();
console.log("Native artifact path scroll passed: stable row across wheel, clipped text ignores wheel");
