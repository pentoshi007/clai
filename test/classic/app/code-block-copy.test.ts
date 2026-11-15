import { afterEach, describe, expect, it, vi } from "vitest";
import { blockContextFor, buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import type { MouseEvent } from "../../../src/classic/input/key-event.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { transcriptItems, type AssistantItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";
import { createHarness, type Harness } from "./harness.js";

const CODE = [
  "curl -fsSL https://example.com/some/really/long/path/to/install.sh?token=abc123&mode=full | bash -s -- --yes",
  "npm install --save-dev typescript @types/node vitest eslint prettier tsx",
].join("\n");

let h: Harness | undefined;
afterEach(() => { h?.dispose(); h = undefined; });

function mouse(x: number, y: number, options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: "left", x, y, release: false, drag: false, scroll: undefined, ctrl: false, alt: false, shift: false, ...options };
}

function setup(columns: number) {
  h = createHarness({ columns, rows: 60 });
  const turn = scriptedTurn();
  const base = transcriptItems(turn.state).find((item) => item.kind === "assistant")!;
  const item: AssistantItem = { ...(base as AssistantItem), text: `Run this:\n\n\`\`\`bash\n${CODE}\n\`\`\`\n\nDone.`, streaming: false };
  h.services.transcript.hydrate({ ...turn.state, order: [item.id], byId: new Map([[item.id, item]]) });
  const state = h.services.transcript.getState();
  const view = { ...feedView(turn, { columns }), spool: h.services.session.spool };
  const blocks = buildFeedBlocks(state, view);
  const window = planTranscriptWindow(blocks, 60, 0);
  h.wiring.observeFeed({ ink: view.ink, context: blockContextFor(state, view), blocks, window, columns, generation: h.wiring.feedGenerationValue, navigationVersion: h.wiring.feedNavigationVersion, requestedOffset: h.wiring.liveOffsetValue });
  h.wiring.setTranscriptSelectionGeometry({ left: 2, top: 3 });
  const rows = window.rows.map((row) => stripAnsi(row.line));
  const writes = vi.spyOn(h.services.ports.clipboard, "writeText").mockResolvedValue(undefined);
  return { rows, writes };
}

describe("classic code block copy", () => {
  it.each([60, 100])("copies the exact block source from its copy tab at %i columns", async (columns) => {
    const { rows, writes } = setup(columns);
    const header = rows.findIndex((row) => row.includes("╭") && row.includes(" copy "));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(rows.some((row) => row.includes("↪"))).toBe(true);
    const x = 2 + rows[header]!.indexOf(" copy ") + 2;
    h!.wiring.handleMouse(mouse(x, 3 + header));
    h!.wiring.handleMouse(mouse(x, 3 + header, { release: true }));
    expect(writes).toHaveBeenCalledWith(CODE);
    expect(h!.services.selection.hasSelection()).toBe(false);
    await vi.waitFor(() => expect(h!.toastTexts()).toContain("Copied code block"));
  });

  it("ignores clicks on the header outside the copy tab", () => {
    const { rows, writes } = setup(80);
    const header = rows.findIndex((row) => row.includes("╭"));
    h!.wiring.handleMouse(mouse(2 + rows[header]!.indexOf("bash"), 3 + header));
    h!.wiring.handleMouse(mouse(2 + rows[header]!.indexOf("bash"), 3 + header, { release: true }));
    expect(writes).not.toHaveBeenCalled();
  });

  it("copies a dragged selection across the wrapped block without frames", async () => {
    const { rows, writes } = setup(60);
    const header = rows.findIndex((row) => row.includes("╭"));
    const bottom = rows.findIndex((row, index) => index > header && row.includes("╰"));
    const start = 2 + rows[header + 1]!.indexOf("│");
    const end = 2 + rows[bottom - 1]!.lastIndexOf("│") + 1;
    h!.wiring.handleMouse(mouse(start, 3 + header + 1));
    h!.wiring.handleMouse(mouse(end, 3 + bottom - 1, { drag: true }));
    h!.wiring.handleMouse(mouse(end, 3 + bottom - 1, { release: true }));
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith(CODE));
  });
});
