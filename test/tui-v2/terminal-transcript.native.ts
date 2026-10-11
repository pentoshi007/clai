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
import { formatToolArgs } from "../../src/agent/tool-call-parser.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

const cases = [
  { name: "terminal.start", args: { command: "ssh analyst@host" }, label: "command:", action: "ssh analyst@host" },
  { name: "terminal.send", args: { id: "its_demo", kind: "text", text: "help" }, label: "action:", action: "help" },
  { name: "terminal.send", args: { id: "its_demo", kind: "secret", value: "dummy-password" }, label: "action:", action: "local input" },
  { name: "terminal.send", args: { id: "its_demo", kind: "control", control: "interrupt" }, label: "action:", action: "interrupt" },
] as const;

for (const width of [120, 80, 40]) {
  for (const testCase of cases) {
    const services = createCompositionRoot({
      noHistory: true,
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
      capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 40 }),
    });
    const output = `[${testCase.name}] state=running transport=pty\n[terminal.output cursor=0 nextCursor=35 earliestAvailableCursor=0 latestCursor=35 hasMore=false view=plain]\nPassword: \nok\nok\n  indented value\nmsf6 > \n[/terminal.output]`;
    const item: ToolItem = {
      id: "terminal-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-terminal"),
      name: testCase.name, argsDisplay: formatToolArgs({ name: testCase.name, args: testCase.args }),
      status: "ok", exitCode: undefined, summary: output, artifactPath: undefined, reason: undefined, outputBytes: output.length, fileChanges: undefined,
    };
    services.session.spool.replace(item.toolCallId, output);
    const setup = await testRender(createElement(ServicesProvider, {
      services,
      children: createElement(TerminalDimensionsContext.Provider, {
        value: { width, height: 40 },
        children: createElement(ToolCard, {
          item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
          expanded: false, services, onToggle() {}, contentWidth: width - 4,
        }),
      }),
    }), { width, height: 40, useThread: false });
    try {
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      assert.ok(frame.includes(testCase.label), frame);
      assert.ok(frame.includes(testCase.action), frame);
      assert.ok(frame.includes("Password:"), frame);
      assert.ok(frame.includes("indented value"), frame);
      assert.ok(frame.includes("msf6 >"), frame);
      assert.ok((frame.match(/\bok\b/g) ?? []).length >= 2, frame);
      assert.ok(!frame.includes("dummy-password"), frame);
      assert.ok(!frame.includes("[/terminal.output]"), frame);
      assert.ok(!frame.includes('"command"'), frame);
    } finally {
      await act(async () => { services.dispose(); setup.renderer.destroy(); });
      await setup.renderer.idle();
    }
  }
}
console.log("Native terminal transcript passed: command, text, secret and control cards at 120/80/40 columns");
