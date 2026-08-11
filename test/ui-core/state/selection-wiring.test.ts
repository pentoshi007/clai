import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ActionRouter } from "../../../src/ui-core/actions/action-router.js";
import { defaultKeymap } from "../../../src/ui-core/actions/keymap.js";
import { SelectionController } from "../../../src/ui-core/controllers/selection-controller.js";
import type { ClipboardPort } from "../../../src/app/ports/clipboard-port.js";

class MemoryClipboard implements ClipboardPort {
  text: string | undefined;
  async writeText(text: string): Promise<void> {
    this.text = text;
  }
}

const TRANSCRIPT_VIEW = "src/tui-v2/components/transcript/transcript-view.tsx";

describe("transcript selection wiring (TUI-005)", () => {
  it("routes the supported selection chords in the transcript context", () => {
    const router = new ActionRouter();
    expect(router.resolve("ctrl+shift+c", "transcript")).toBe("selection.copy");
    expect(router.resolve("ctrl+a", "transcript")).toBe("selection.select-all");
    expect(router.resolve("escape", "transcript")).toBe("selection.clear");
  });

  it("declares no keyboard range-extension chords without a visible caret", () => {
    const extendBindings = defaultKeymap.filter((binding) =>
      binding.action.startsWith("selection.extend-"),
    );
    expect(extendBindings).toEqual([]);
  });

  it("select-all then copy puts the whole transcript document on the clipboard", async () => {
    const clipboard = new MemoryClipboard();
    const selection = new SelectionController(clipboard);
    selection.setDocument("transcript", {
      blocks: [
        { id: "a", text: "SELECT-ALL-FIRST" },
        { id: "b", text: "SELECT-ALL-SECOND" },
      ],
    });
    const router = new ActionRouter();

    const selectAll = router.resolve("ctrl+a", "transcript")!;
    expect(selection.handleAction(selectAll, "transcript")).toBe(true);
    expect(selection.hasSelection()).toBe(true);

    const result = await selection.copy();
    expect(result.status).toBe("copied");
    expect(clipboard.text).toContain("SELECT-ALL-FIRST");
    expect(clipboard.text).toContain("SELECT-ALL-SECOND");
  });

  it("clear drops the selection so Esc can fall through to cancel", () => {
    const selection = new SelectionController(new MemoryClipboard());
    selection.setDocument("transcript", { blocks: [{ id: "a", text: "text" }] });
    selection.handleAction("selection.select-all", "transcript");
    expect(selection.hasSelection()).toBe(true);
    selection.handleAction("selection.clear", "transcript");
    expect(selection.hasSelection()).toBe(false);
  });

  it("keeps the selection hook wired into the transcript view", () => {
    const source = readFileSync(TRANSCRIPT_VIEW, "utf8");
    expect(source).toContain("useTranscriptSelection");
    expect(source).toContain("selection.handleKey(key, chord)");
    expect(source).toContain("renderer.hasSelection");
  });

  it("never clears the native selection while a pointer drag is active", () => {
    const source = readFileSync(TRANSCRIPT_VIEW, "utf8");
    expect(source).toContain("renderer.hasSelection && !pointerGestureActive.current");
    const guards = source.match(/if \(pointerGestureActive\.current\) return;/g);
    expect(guards?.length).toBeGreaterThanOrEqual(2);
  });
});
