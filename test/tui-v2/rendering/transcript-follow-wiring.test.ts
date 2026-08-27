import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TRANSCRIPT_VIEW = "src/tui-v2/components/transcript/transcript-view.tsx";
const THINKING_BLOCK = "src/tui-v2/components/transcript/thinking-block.tsx";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("transcript follow wiring", () => {
  it("drives stickyScroll from render state, not a mutable ref", () => {
    const text = source(TRANSCRIPT_VIEW);
    // Reading `followBottom.current` during render leaves native sticky scroll
    // stale after End / Ctrl+D re-enables follow, so the viewport never
    // settles at a growing bottom.
    expect(text).toContain("stickyScroll={followSticky}");
    expect(text).not.toContain("stickyScroll={followBottom.current}");
  });

  it("keeps the follow ref and its render mirror in sync", () => {
    const text = source(TRANSCRIPT_VIEW);
    const setFollowing = text.slice(
      text.indexOf("function setFollowing("),
      text.indexOf("function updateFollowingFromPosition("),
    );
    expect(setFollowing).toContain("followBottom.current = on");
    expect(setFollowing).toContain("setFollowSticky(on)");
  });

  it("releases thinking wheel focus when a press lands outside a card", () => {
    expect(source(TRANSCRIPT_VIEW)).toContain("services.transcript.blurThinking()");
  });

  it("releases thinking wheel focus when the pointer leaves the card", () => {
    const text = source(THINKING_BLOCK);
    expect(text).toContain("onMouseOut={onCardMouseOut}");
    expect(text).toContain("if (focused && !isInsideCard(event)) onBlur?.()");
  });

  it("pages the thinking body while drag-selecting at its edges", () => {
    const text = source(THINKING_BLOCK);
    expect(text).toContain("onMouseDrag={onBodyDrag}");
    expect(text).toContain("onMouseDragEnd={endBodyDrag}");
    // Autoscroll continues while the pointer is held still at an edge…
    expect(text).toContain("startDragScroll");
    // …and the gesture is released once that end is reached so the selection
    // can continue into the transcript.
    expect(text).toContain("if (up || down) endBodyDrag();");
  });

  it("copies the focused thinking card with `c` and then releases it", () => {
    const text = source(TRANSCRIPT_VIEW);
    expect(text).toContain('=== "transcript.copy-thinking"');
    // Only while the transcript owns the keyboard, so composer typing is safe.
    expect(text).toContain('services.focus.activeContext() === "transcript"');
    expect(text).toContain("state.focusedThinkingId !== undefined");
    // Focus is released only after a successful copy.
    const handler = text.slice(
      text.indexOf("copyFocusedThinking(state"),
      text.indexOf("Nothing to copy"),
    );
    expect(handler).toContain('result === "copied"');
    expect(handler).toContain("services.transcript.blurThinking()");
  });
});
