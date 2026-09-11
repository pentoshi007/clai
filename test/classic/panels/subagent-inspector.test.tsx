import { writeFile } from "node:fs/promises";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import type { SubagentRun } from "../../../src/agent/subagents/types.js";
import { PanelHost } from "../../../src/classic/panels/panel-host.js";
import { formatSubagentRun } from "../../../src/ui-core/rendering/subagent-source.js";
import { createHarness, ink } from "./harness.js";

it("renders readable subagent activity and one evidence report in Classic", async () => {
  const report = "Status: complete\n## Findings\nThe worker delegates bounded read-only research.\n## Evidence\nsrc/agent/subagents/worker.ts:81 contains the dispatch loop.\n## Next steps\nVerify cancellation.\n## Coverage gaps\nNo live provider was contacted.";
  const run: SubagentRun = {
    id: "inspector", parentSessionId: "parent", title: "Inspect orchestration", prompt: "Trace the worker and report evidence",
    cwd: "/workspace", provider: "openai", model: "test", attempt: 1, status: "completed", createdAt: 1, updatedAt: 2,
    events: [
      { sequence: 1, timestamp: 1, kind: "tool", text: 'Calling fs.read: {"path":"src/agent/subagents/worker.ts","offset":81,"limit":80}' },
      { sequence: 2, timestamp: 2, kind: "tool", text: "Success: PRIVATE_FILE_BODY_MUST_NOT_APPEAR" },
      { sequence: 3, timestamp: 3, kind: "assistant", text: report },
    ],
    report,
  };
  const harness = createHarness({ columns: 120, rows: 46 });
  harness.overlay.openPager(run.title, formatSubagentRun(run), undefined, undefined, "force");
  const view = render(<PanelHost controller={harness.panels} ink={ink} columns={120} rows={40} jobs={[]} transcript={harness.transcript} now={0} />);
  try {
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("fs.read src/agent/subagents/worker.ts");
    expect(frame).toContain("offset=81, limit=80");
    expect(frame).not.toContain("PRIVATE_FILE_BODY_MUST_NOT_APPEAR");
    expect(frame.match(/The worker delegates/g)).toHaveLength(1);
    expect(frame).toContain("No live provider was contacted.");
    if (process.env.CLAI_CLASSIC_SUBAGENT_CAPTURE_PATH) await writeFile(process.env.CLAI_CLASSIC_SUBAGENT_CAPTURE_PATH, frame);
  } finally {
    view.unmount();
    harness.overlay.dispose();
    harness.panels.dispose();
  }
});
