import { describe, expect, it } from "vitest";
import type { ClipboardPort } from "../../../src/app/ports/clipboard-port.js";
import {
  SelectionController,
  type DragEdgeScrollPort,
} from "../../../src/tui-v2/controllers/selection-controller.js";
import { SEMANTIC_BLOCK_SEPARATOR } from "../../../src/tui-v2/state/semantic-document.js";

class MemoryClipboard implements ClipboardPort {
  text: string | undefined;
  async writeText(text: string): Promise<void> {
    this.text = text;
  }
}

function chatDocument() {
  return {
    blocks: [
      { id: "chat-a", text: "CHAT-FIRST-SENTINEL alpha beta\nline two" },
      { id: "chat-b", text: "CHAT-SECOND-SENTINEL omega" },
    ],
  };
}

function planDocument() {
  return { blocks: [{ id: "plan-a", text: "PLAN-SENTINEL must never copy" }] };
}

function configured() {
  const clipboard = new MemoryClipboard();
  const selection = new SelectionController(clipboard);
  selection.setDocument("transcript", chatDocument());
  selection.setDocument("plan", planDocument());
  return { clipboard, selection };
}

function scrollSpy(): DragEdgeScrollPort & { starts: number; updates: number; stops: number } {
  return {
    starts: 0,
    updates: 0,
    stops: 0,
    startAutoScroll() {
      this.starts += 1;
    },
    updateAutoScroll() {
      this.updates += 1;
    },
    stopAutoScroll() {
      this.stops += 1;
    },
  };
}

describe("SelectionController (V2-060..064)", () => {
  it("copies source-order chat sentinels exactly and never includes another pane", async () => {
    const { clipboard, selection } = configured();
    const first = chatDocument().blocks[0]!;
    const second = chatDocument().blocks[1]!;

    expect(selection.beginDrag("transcript", { blockId: first.id, offset: 0 })).toBe(true);
    expect(
      selection.dragTo("transcript", { blockId: second.id, offset: second.text.length }),
    ).toBe(true);
    selection.finishDrag();

    const expected = `${first.text}${SEMANTIC_BLOCK_SEPARATOR}${second.text}`;
    expect(selection.selectedText()).toBe(expected);
    expect(selection.selectedText()).not.toContain("PLAN-SENTINEL");
    // Auto-copy is off by default — explicit copy only.
    expect(clipboard.text).toBeUndefined();
    await expect(selection.copy()).resolves.toEqual({ status: "copied", text: expected });
    expect(clipboard.text).toBe(expected);
  });

  it("clamps anchors and refuses a drag that crosses into another pane", () => {
    const { selection } = configured();
    const first = chatDocument().blocks[0]!;

    selection.beginDrag("transcript", { blockId: first.id, offset: -100 });
    selection.dragTo("transcript", { blockId: first.id, offset: 10_000 });
    expect(
      selection.dragTo("plan", { blockId: "plan-a", offset: 10_000 }),
    ).toBe(false);
    selection.finishDrag();

    expect(selection.selectedText()).toBe(first.text);
    expect(selection.selectedText()).not.toContain("PLAN-SENTINEL");
  });

  it("selects word and logical line boundaries, then extends only the transcript", () => {
    const { selection } = configured();
    selection.setDocument("transcript", { blocks: [{ id: "chat", text: "one beta\ntwo" }] });

    selection.click("transcript", { blockId: "chat", offset: 5 }, "word");
    expect(selection.selectedText()).toBe("beta");

    selection.click("transcript", { blockId: "chat", offset: 5 }, "line");
    expect(selection.selectedText()).toBe("one beta\n");

    selection.click("transcript", { blockId: "chat", offset: 0 });
    expect(selection.handleAction("selection.extend-word-right", "transcript")).toBe(true);
    expect(selection.selectedText()).toBe("one");
    expect(selection.handleAction("selection.select-all", "plan")).toBe(true);
    expect(selection.selectedText()).toBe("PLAN-SENTINEL must never copy");
  });

  it("owns only the active pane's native autoscroll lifecycle", () => {
    const { selection } = configured();
    const transcriptScroll = scrollSpy();
    const planScroll = scrollSpy();
    selection.registerScrollPort("transcript", transcriptScroll);
    selection.registerScrollPort("plan", planScroll);

    selection.beginDrag("transcript", { blockId: "chat-a", offset: 0 }, { x: 4, y: 4 });
    selection.dragTo("transcript", { blockId: "chat-b", offset: 3 }, { x: 4, y: 99 });
    expect(selection.dragTo("plan", { blockId: "plan-a", offset: 2 }, { x: 50, y: 99 })).toBe(false);
    selection.finishDrag();

    expect(transcriptScroll.starts).toBe(1);
    expect(transcriptScroll.updates).toBe(2);
    expect(transcriptScroll.stops).toBe(1);
    expect(planScroll.starts).toBe(0);
    expect(planScroll.updates).toBe(0);
    expect(planScroll.stops).toBe(0);
  });

  it("keeps stable anchors through streaming document updates and resize-equivalent refreshes", () => {
    const { selection } = configured();
    selection.beginDrag("transcript", { blockId: "chat-a", offset: 5 });
    selection.dragTo("transcript", { blockId: "chat-b", offset: 8 });
    selection.finishDrag();
    const before = selection.getState().range;

    selection.setDocument("transcript", {
      blocks: [
        { id: "chat-a", text: "CHAT-FIRST-SENTINEL alpha beta\nline two" },
        { id: "chat-b", text: "CHAT-SECOND-SENTINEL omega while streaming" },
      ],
    });
    const afterStream = selection.getState().range;
    selection.setDocument("transcript", chatDocument());
    const afterResize = selection.getState().range;

    expect(afterStream?.anchor).toEqual(before?.anchor);
    expect(afterStream?.focus).toEqual(before?.focus);
    expect(afterResize).toEqual(before);
  });

  it("contains clipboard failures instead of throwing from an input action", async () => {
    const selection = new SelectionController({
      async writeText() {
        throw new Error("clipboard unavailable");
      },
    });
    selection.setDocument("transcript", chatDocument());
    selection.selectAll("transcript");

    const result = await selection.copy();
    expect(result.status).toBe("failed");
  });

  it("does not auto-copy on release by default", () => {
    const { clipboard, selection } = configured();
    const first = chatDocument().blocks[0]!;
    const alphaOffset = first.text.indexOf("alpha") + 2;

    selection.click("transcript", { blockId: first.id, offset: alphaOffset }, "word");
    expect(selection.selectedText()).toBe("alpha");
    expect(clipboard.text).toBeUndefined();

    selection.beginDrag("transcript", { blockId: first.id, offset: 0 });
    selection.dragTo("transcript", { blockId: first.id, offset: 4 });
    selection.finishDrag();
    expect(clipboard.text).toBeUndefined();
  });

  it("does not auto-copy keyboard-built selections; Ctrl+Shift+C (selection.copy) does", async () => {
    const { clipboard, selection } = configured();
    selection.click("transcript", { blockId: "chat-a", offset: 0 });
    selection.handleAction("selection.extend-word-right", "transcript");
    expect(clipboard.text).toBeUndefined();

    selection.handleAction("selection.copy", "transcript");
    await Promise.resolve();
    expect(clipboard.text).toBe("CHAT");
  });

  it("copyOnRelease can be enabled when explicitly requested", () => {
    const clipboard = new MemoryClipboard();
    const selection = new SelectionController(clipboard, { copyOnRelease: true });
    selection.setDocument("transcript", chatDocument());

    selection.click("transcript", { blockId: "chat-a", offset: 2 }, "word");
    expect(clipboard.text).toBe("CHAT");
  });
});
