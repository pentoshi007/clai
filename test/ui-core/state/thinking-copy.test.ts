import { describe, expect, it } from "vitest";
import type { ClipboardPort } from "../../../src/app/ports/clipboard-port.js";
import {
  copyFocusedThinking,
  focusedThinkingContent,
} from "../../../src/ui-core/state/thinking-copy.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type ThinkingItem,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";

class MemoryClipboard implements ClipboardPort {
  text: string | undefined;
  async writeText(text: string): Promise<void> {
    this.text = text;
  }
}

class BrokenClipboard implements ClipboardPort {
  async writeText(): Promise<void> {
    throw new Error("no clipboard");
  }
}

function thinking(id: string, content: string): ThinkingItem {
  return {
    id,
    kind: "thinking",
    sequence: 1,
    turnId: undefined,
    timestamp: 1,
    content,
    streaming: false,
    startedAt: 1,
    endedAt: 2,
  };
}

function stateWith(
  item: ThinkingItem,
  focusedThinkingId: string | undefined,
): TranscriptState {
  return {
    ...EMPTY_TRANSCRIPT_STATE,
    order: [item.id],
    byId: new Map([[item.id, item]]),
    focusedThinkingId,
  };
}

describe("copy focused thinking", () => {
  it("copies the whole reasoning, not just the visible window", async () => {
    const clipboard = new MemoryClipboard();
    const content = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const state = stateWith(thinking("t1", content), "t1");

    expect(await copyFocusedThinking(state, clipboard)).toBe("copied");
    expect(clipboard.text).toBe(content);
    expect(clipboard.text?.split("\n")).toHaveLength(80);
  });

  it("normalizes CRLF and trims trailing blank space", async () => {
    const clipboard = new MemoryClipboard();
    const state = stateWith(thinking("t1", "first\r\nsecond\r\n\n  "), "t1");

    expect(await copyFocusedThinking(state, clipboard)).toBe("copied");
    expect(clipboard.text).toBe("first\nsecond");
  });

  it("does nothing when no card is focused", async () => {
    const clipboard = new MemoryClipboard();
    const state = stateWith(thinking("t1", "reasoning"), undefined);

    expect(await copyFocusedThinking(state, clipboard)).toBe("none");
    expect(clipboard.text).toBeUndefined();
    expect(focusedThinkingContent(state)).toBeUndefined();
  });

  it("reports empty reasoning instead of clearing the clipboard", async () => {
    const clipboard = new MemoryClipboard();
    const state = stateWith(thinking("t1", "   \n  "), "t1");

    expect(await copyFocusedThinking(state, clipboard)).toBe("empty");
    expect(clipboard.text).toBeUndefined();
  });

  it("reports a clipboard failure instead of throwing", async () => {
    const state = stateWith(thinking("t1", "reasoning"), "t1");
    expect(await copyFocusedThinking(state, new BrokenClipboard())).toBe("failed");
  });
});
