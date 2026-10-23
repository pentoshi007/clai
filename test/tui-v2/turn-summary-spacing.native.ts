import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TranscriptRow } from "../../src/tui-v2/components/transcript/transcript-row.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { asTurnId } from "../../src/app/events/app-event.js";
import type { TranscriptItem } from "../../src/ui-core/state/transcript-types.js";

const width = 100;
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
    rows: 30,
  }),
});
const theme = themeFor(services.capabilities.themeHint);
const turnId = asTurnId("spacing-turn");
const summary: TranscriptItem = {
  id: "summary-row",
  kind: "turn-summary",
  sequence: 1,
  turnId,
  timestamp: 0,
  durationMs: 101_000,
  status: "completed",
  changes: undefined,
  generation: undefined,
} as TranscriptItem;
const message: TranscriptItem = {
  id: "message-row",
  kind: "user",
  sequence: 2,
  turnId,
  timestamp: 1,
  text: "next prompt after the summary",
} as TranscriptItem;

const setup = await testRender(
  createElement(ServicesProvider, {
    services,
    children: createElement(TerminalDimensionsContext.Provider, {
      value: { width, height: 30 },
      children: createElement(
        "box",
        { style: { flexDirection: "column", width: "100%" } },
        createElement(TranscriptRow, {
          item: summary,
          theme,
          store: services.transcript,
          spool: services.session.spool,
          services,
          onOpenUserPrompt: () => {},
          expanded: false,
          fileDiffExpanded: false,
          expandThinkingGlobal: false,
          expandOutputGlobal: false,
          expandFileDiffsGlobal: false,
          contentWidth: width - 4,
        }),
        createElement(TranscriptRow, {
          item: message,
          theme,
          store: services.transcript,
          spool: services.session.spool,
          services,
          onOpenUserPrompt: () => {},
          expanded: false,
          fileDiffExpanded: false,
          expandThinkingGlobal: false,
          expandOutputGlobal: false,
          expandFileDiffsGlobal: false,
          contentWidth: width - 4,
        }),
      ),
    }),
  }),
  { width, height: 30, useThread: false },
);

try {
  await act(async () => {
    await setup.flush();
  });
  const rows = setup.captureCharFrame().split("\n");
  const summaryIndex = rows.findIndex((row) => row.includes("Worked for"));
  assert.ok(summaryIndex >= 0, rows.join("\n"));
  const messageIndex = rows.findIndex((row) => row.includes("next prompt after the summary"));
  assert.ok(messageIndex > summaryIndex, rows.join("\n"));
  const between = rows[summaryIndex + 1] ?? "";
  assert.ok(
    between.trim() === "",
    `expected a blank separator row after the turn summary:\n${rows.join("\n")}`,
  );
  console.log("Turn summary spacing passed: blank row directly after the summary");
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
}
