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

const rows = ["HEAD_1", "HEAD_2", "HEAD_3", "HIDDEN_4", "TAIL_5"];
const cases = [
  { name: "shell.exec", argsDisplay: "printf output", body: rows.join("\n") },
  { name: "shell.exec", argsDisplay: "printf long", body: [rows[0] + "x".repeat(20_000), ...rows.slice(1)].join("\n") },
  { name: "fs.cat", argsDisplay: "README.md", body: rows.map(row => `- **${row}**`).join("\n") },
  { name: "tool.batch", argsDisplay: "1 call: shell.exec", body: `── #1 shell.exec [fail exit=2]\n${rows.join("\n")}` },
];

let scenarios = 0;
for (const width of [120, 80, 40]) {
  for (const testCase of cases) {
    for (const expanded of [false, true]) {
      const services = createCompositionRoot({
        noHistory: true,
        persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
        capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 60 }),
      });
      const item: ToolItem = {
        id: "preview-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-preview"),
        name: testCase.name, argsDisplay: testCase.argsDisplay,
        status: testCase.name === "tool.batch" ? "failed" : "ok", exitCode: undefined, summary: undefined,
        artifactPath: undefined, reason: undefined, outputBytes: testCase.body.length, fileChanges: undefined,
      };
      services.session.spool.replace(item.toolCallId, testCase.body);
      const setup = await testRender(createElement(ServicesProvider, {
        services,
        children: createElement(TerminalDimensionsContext.Provider, {
          value: { width, height: 60 },
          children: createElement(ToolCard, {
            item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
            expanded, services, onToggle() {}, contentWidth: width - 4,
          }),
        }),
      }), { width, height: 60, useThread: false });
      try {
        await act(async () => { await setup.flush(); });
        const frame = setup.captureCharFrame();
        for (const row of rows.slice(0, 3)) assert.ok(frame.includes(row), frame);
        for (const row of rows.slice(3)) assert.equal(frame.includes(row), expanded, frame);
        if (!expanded && testCase.name !== "fs.cat") {
          assert.equal(frame.split("\n").filter(row => /│ HEAD_[123]/.test(row)).length, 3, frame);
        }
        assert.ok(frame.includes("Ctrl+O"), frame);
        if (testCase.name === "tool.batch") assert.ok(frame.includes("exit 2"), frame);
        assert.equal(services.session.spool.tail(item.toolCallId), testCase.body);
        scenarios += 1;
      } finally {
        await act(async () => { services.dispose(); setup.renderer.destroy(); });
        await setup.renderer.idle();
      }
    }
  }
}
console.log(`Native output previews passed: ${scenarios} plain, long, formatted and batch collapsed/expanded scenarios at 120/80/40 columns`);
