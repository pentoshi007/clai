import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { ARGS_PREVIEW_MAX_CHARS } from "../../src/ui-core/rendering/tool-presenter.js";
import { asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

const settle = async (work: () => unknown): Promise<void> => {
  await act(async () => { await work(); });
  await new Promise((resolve) => setTimeout(resolve, 30));
};

const commands = [
  { label: "multi-line heredoc", command: ["cat > notes.txt << 'EOF'", "first", "", "second", "third", "fourth", "EOF"].join("\n") },
  { label: "single very long line", command: `python3 -c '${"total += value; ".repeat(120)}'` },
];

let scenarios = 0;
for (const width of [220, 100, 60]) {
  for (const testCase of commands) {
    const services = createCompositionRoot({
      noHistory: true,
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
      capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 50 }),
    });
    const item: ToolItem = {
      id: "input-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-input"),
      name: "shell.exec", argsDisplay: testCase.command, status: "ok", exitCode: 0, summary: undefined,
      artifactPath: undefined, reason: undefined, outputBytes: 12, fileChanges: undefined,
    };
    services.session.spool.replace(item.toolCallId, "OUTPUT_LINE");
    const setup = await testRender(createElement(ServicesProvider, {
      services,
      children: createElement(TerminalDimensionsContext.Provider, {
        value: { width, height: 50 },
        children: createElement(ToolCard, {
          item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
          expanded: false, services, onToggle() {}, contentWidth: width - 4,
        }),
      }),
    }), { width, height: 50, useThread: false });
    try {
      await settle(() => setup.flush());
      const frame = setup.captureCharFrame().split("\n");
      const first = frame.findIndex((row) => row.includes("command:"));
      assert.ok(first >= 0, frame.join("\n"));
      const hint = frame.findIndex((row, index) => index >= first && row.includes("click for full"));
      assert.ok(hint > first, `${testCase.label} at ${width}: expected a pager hint\n${frame.join("\n")}`);
      assert.ok(hint - first <= 3, `${testCase.label} at ${width}: input exceeded three rows\n${frame.join("\n")}`);
      const shown = frame.slice(first, hint).map((row) => row.replace(/^\s*│\s*(?:command: )?/, "").replace(/\s*│\s*$/, "")).join("");
      assert.ok(shown.length <= ARGS_PREVIEW_MAX_CHARS, `${testCase.label} at ${width}: ${shown.length} chars shown`);

      assert.equal(services.overlay.getState().kind, "none");
      const column = frame[first]!.indexOf("command:") + "command: ".length + 2;
      await settle(() => setup.mockMouse.click(column, first));
      for (let attempt = 0; attempt < 20 && services.overlay.getState().kind !== "pager"; attempt += 1) {
        await settle(() => setup.flush());
      }
      const state = services.overlay.getState();
      assert.equal(state.kind, "pager", `${testCase.label} at ${width}: clicking the input did not open the pager`);
      if (state.kind === "pager") {
        assert.ok(state.body.includes(testCase.command), "pager shows the full command");
        assert.ok(state.body.includes("OUTPUT_LINE"), "pager shows the output");
        assert.equal(state.regions?.inputEnd, testCase.command.split("\n").length);
      }
      scenarios += 1;
    } finally {
      await act(async () => { services.dispose(); setup.renderer.destroy(); });
    }
  }
}

assert.equal(scenarios, 6);
console.log(`Native tool input pager passed: ${scenarios} bounded-input and click-to-pager scenarios at 220/100/60 columns`);
