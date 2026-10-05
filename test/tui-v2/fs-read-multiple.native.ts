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
import { formatFsReadSection } from "../../src/tools/fs/read-sections.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

for (const width of [120, 80, 40]) {
  for (const mode of ["single", "multiple", "batch"] as const) {
    const services = createCompositionRoot({
      noHistory: true,
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
      capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 40 }),
    });
    const files = Array.from({ length: mode === "single" ? 1 : 6 }, (_, index) => ({
      path: index === 2 ? `src/${"long-directory/".repeat(12)}file-3.ts` : `src/file-${index + 1}.ts`,
      ...(index === 2 ? { pattern: "export", context: 1 }
        : index === 4 ? { pattern: "long_symbol_".repeat(200), context: 2 }
          : { offset: index + 1, limit: 8 }),
    }));
    const output = files.map((file, index) => formatFsReadSection({
      index: index + 1, total: files.length, path: file.path, ok: index !== 2,
      body: index === 2 ? "ENOENT: missing file" : `# fs.read path=/repo/${file.path} lines=1-8 of 100 bytes=900\nPRIVATE_FILE_BODY\n# hasMore=true`,
    })).join("\n\n");
    const args = mode === "single" ? files[0]! : { files };
    const item: ToolItem = {
      id: "read-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-read"),
      name: mode === "batch" ? "tool.batch" : "fs.read", argsDisplay: mode === "batch" ? "1 call: fs.read" : formatToolArgs({ name: "fs.read", args }),
      status: mode === "single" ? "ok" : "failed", exitCode: mode === "single" ? 0 : 1,
      summary: undefined, artifactPath: undefined, reason: undefined, outputBytes: output.length, fileChanges: undefined,
    };
    services.session.spool.replace(item.toolCallId, mode === "batch" ? `── #1 fs.read [fail exit=1]\n${output}` : output);
    const setup = await testRender(createElement(ServicesProvider, {
      services,
      children: createElement(TerminalDimensionsContext.Provider, {
        value: { width, height: 40 },
        children: createElement(ToolCard, {
          item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
          expanded: false, services, onToggle() {}, contentWidth: width - 4,
        }),
      }),
    }), { width, height: 40, useThread: false, useMouse: true });
    try {
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      assert.match(frame, /fs.read/);
      for (let index = 0; index < files.length; index += 1) assert.ok(frame.includes(`file-${index + 1}.ts`), frame);
      if (mode === "single") {
        assert.match(frame, /options: lines=1–8/);
        assert.match(frame, /file: src\/file-1.ts/);
      } else {
        assert.match(frame, /file 6\/6/);
        assert.ok(frame.includes("✗"), frame);
        assert.ok(frame.includes("✓"), frame);
        if (mode === "multiple") {
          assert.match(frame, /pattern="export"/);
          assert.match(frame, /options: offset=6/);
        }
      }
      assert.ok(!frame.includes("PRIVATE_FILE_BODY"), frame);
      assert.ok(!frame.includes('"files"'), frame);
      const card = setup.renderer.root.findDescendantById(item.id);
      assert.ok(card && card.height < 32, `unbounded read card at ${width} columns`);
      assert.ok(setup.renderer.root.getChildren().length > 0);
    } finally {
      await act(async () => { services.dispose(); setup.renderer.destroy(); });
      await setup.renderer.idle();
    }
  }
}
console.log("Native fs.read passed: single, six-file, failure, long-path and nested batch cards at 120/80/40 columns");
