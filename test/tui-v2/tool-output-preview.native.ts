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
const cases: {
  name: string;
  argsDisplay: string;
  body: string;
  status?: ToolItem["status"];
  detail?: string;
}[] = [
  { name: "shell.exec", argsDisplay: "printf output", body: rows.join("\n") },
  { name: "shell.exec", argsDisplay: "printf first\nprintf second\nprintf third", body: rows.join("\n") },
  { name: "shell.exec", argsDisplay: "printf long", body: [rows[0] + "x".repeat(20_000), ...rows.slice(1)].join("\n") },
  { name: "shell.exec", argsDisplay: "printf failed", body: rows.join("\n"), status: "failed", detail: "Network error: inspect /tmp/log.txt before retrying the command" },
  { name: "shell.exec", argsDisplay: "printf blocked", body: rows.join("\n"), status: "blocked", detail: "Access blocked\nInspect /tmp/blocked.txt before retrying" },
  { name: "shell.exec", argsDisplay: "printf running", body: rows.join("\n"), status: "running" },
  { name: "shell.exec", argsDisplay: "printf empty", body: "" },
  { name: "shell.exec", argsDisplay: "printf waiting", body: "", status: "running" },
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
        id: "preview-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: Date.now(), kind: "tool", toolCallId: asToolCallId("call-preview"),
        name: testCase.name, argsDisplay: testCase.argsDisplay,
        status: testCase.status ?? (testCase.name === "tool.batch" ? "failed" : "ok"), exitCode: undefined,
        summary: testCase.status === "failed" ? testCase.detail : undefined,
        artifactPath: undefined, reason: testCase.status === "blocked" ? testCase.detail : undefined,
        outputBytes: testCase.body.length, fileChanges: undefined,
      };
      services.session.spool.replace(item.toolCallId, testCase.body);
      let toggles = 0;
      const setup = await testRender(createElement(ServicesProvider, {
        services,
        children: createElement(TerminalDimensionsContext.Provider, {
          value: { width, height: 60 },
          children: createElement(ToolCard, {
            item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
            expanded, services, onToggle() { toggles += 1; }, contentWidth: width - 4,
          }),
        }),
      }), { width, height: 60, useThread: false, useMouse: true });
      try {
        await act(async () => { await setup.flush(); });
        const frame = setup.captureCharFrame();
        for (const row of rows.slice(0, 3)) assert.equal(frame.includes(row), Boolean(testCase.body), frame);
        for (const row of rows.slice(3)) assert.equal(frame.includes(row), Boolean(testCase.body) && expanded, frame);
        const frameRows = frame.split("\n");
        assert.ok(!frame.includes("OUTPUT"), frame);
        assert.doesNotMatch(frame, /\b(?:expand|collapse) all\b/i);
        if (testCase.name === "tool.batch" && !expanded) {
          assert.equal(frameRows.filter(row => /│ HEAD_[123]/.test(row)).length, 3, frame);
        }
        if (testCase.name !== "tool.batch" && testCase.body) {
          const outputRow = frameRows.findIndex(row => row.includes("HEAD_1"));
          const branchColumn = frameRows[outputRow]!.indexOf("└─ ");
          assert.ok(branchColumn >= 0, frame);
          assert.equal(frameRows[outputRow - 1]?.[branchColumn], "│", frame);
          if (testCase.name === "shell.exec") {
            const commandRow = frameRows.findIndex(row => row.includes("command:"));
            assert.ok(outputRow >= commandRow + 2, frame);
            assert.equal(branchColumn, frameRows[commandRow]!.indexOf("command:"), frame);
            for (const stemRow of frameRows.slice(commandRow + 1, outputRow)) {
              assert.equal(stemRow[branchColumn], "│", frame);
            }
          }
        }
        if (!testCase.body) assert.ok(!frame.includes("└─ "), frame);
        assert.equal(frame.includes("Ctrl+O"), Boolean(testCase.body) && (item.status !== "running" || !expanded), frame);
        if (testCase.name !== "tool.batch" && testCase.body) {
          const headerRow = frameRows.findIndex(row => row.includes(item.name));
          const label = expanded ? "collapse" : "expand";
          const controlColumn = frameRows[headerRow]!.indexOf(label);
          assert.ok(controlColumn >= 0, frame);
          await act(async () => {
            await setup.mockMouse.click(controlColumn + 1, headerRow);
            await setup.flush();
          });
          assert.equal(toggles, 1, frame);
          assert.equal(services.overlay.getState().kind, "none", frame);
        }
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
