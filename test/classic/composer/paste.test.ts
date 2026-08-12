import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../src/app/commands/registry.js";
import type { ClipboardPort } from "../../../src/app/ports/clipboard-port.js";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import { composerFrame, composerTextRowsWanted } from "../../../src/classic/chrome/composer-frame.js";
import { layoutEditor } from "../../../src/classic/chrome/editor-view.js";
import { isLargePaste } from "../../../src/ui-core/composer/paste-placeholder.js";

function clipboard(): ClipboardPort & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    async writeText(text: string) {
      written.push(text);
    },
    async readText() {
      return "";
    },
  };
}

function controller(overrides: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const deps = makeDeps(overrides);
  return { composer: new ComposerController(deps), deps };
}

function makeDeps(overrides: {
  readonly onSubmit?: (prompt: string) => void;
  readonly onToast?: (text: string) => void;
  readonly clipboard?: ClipboardPort;
} = {}) {
  const commands = new CommandRegistry();
  commands.register({ name: "help", description: "show help" });
  return {
    commands,
    clipboard: overrides.clipboard ?? clipboard(),
    baseDir: process.cwd(),
    onSubmit: overrides.onSubmit ?? vi.fn(),
    onToast: overrides.onToast ?? vi.fn(),
    onScrollChat: vi.fn(),
    onJumpTop: vi.fn(),
  };
}

const BIG = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");

describe("large paste", () => {
  it("classifies by line and character count", () => {
    expect(isLargePaste("one\ntwo")).toBe(false);
    expect(isLargePaste(BIG)).toBe(true);
    expect(isLargePaste("x".repeat(801))).toBe(true);
  });

  it("shows a single bounded chip token in the draft", () => {
    const { composer } = controller();
    composer.paste(BIG);
    expect(composer.text).toBe("[500 lines pasted #1]");
    expect(layoutEditor(composer.getSnapshot().state, 40).rows).toHaveLength(1);
    expect(composer.getSnapshot().pastes).toHaveLength(1);
  });

  it("expands the placeholder at submit and drops the registry", () => {
    const onSubmit = vi.fn();
    const { composer } = controller({ onSubmit });
    composer.paste(BIG);
    composer.insertText(" run this");
    composer.handleAction("editor.submit");
    expect(onSubmit).toHaveBeenCalledWith(`${BIG} run this`);
    expect(composer.text).toBe("");
    expect(composer.getSnapshot().pastes).toEqual([]);
  });

  it("inserts a small paste verbatim", () => {
    const { composer } = controller();
    composer.paste("one\ntwo");
    expect(composer.text).toBe("one\ntwo");
    expect(composer.getSnapshot().pastes).toEqual([]);
  });

  it("normalises CRLF so wrapping and row counts stay correct", () => {
    const { composer } = controller();
    composer.paste("one\r\ntwo\rthree");
    expect(composer.text).toBe("one\ntwo\nthree");
  });

  it("never resolves pasted bytes to a shortcut or a command menu", () => {
    const { composer } = controller();
    composer.paste("/help me\nnow");
    expect(composer.text).toBe("/help me\nnow");
    expect(composer.getSnapshot().menu.kind).toBe("none");
  });

  it("keeps several placeholders independent", () => {
    const { composer } = controller();
    composer.paste(BIG);
    composer.insertText(" ");
    composer.paste(BIG);
    expect(composer.text).toBe("[500 lines pasted #1] [500 lines pasted #2]");
    expect(composer.getSnapshot().pastes).toHaveLength(2);
    expect(composer.expand(composer.text)).toBe(`${BIG} ${BIG}`);
  });

  it("drops a placeholder from the chip list when its token is deleted", () => {
    const { composer } = controller();
    composer.paste(BIG);
    composer.setText("");
    expect(composer.getSnapshot().pastes).toEqual([]);
  });

  it("cuts the expanded text to the clipboard and clears the draft", async () => {
    const board = clipboard();
    const onToast = vi.fn();
    const { composer } = controller({ clipboard: board, onToast });
    composer.paste(BIG);
    composer.handleAction("editor.cut-draft");
    await vi.waitFor(() =>
      expect(onToast).toHaveBeenCalledWith("Draft cut to clipboard · ^X"),
    );
    expect(board.written).toEqual([BIG]);
    expect(composer.text).toBe("");
  });

  it("clears the draft even when the clipboard fails", async () => {
    const onToast = vi.fn();
    const { composer } = controller({
      onToast,
      clipboard: {
        async writeText() {
          throw new Error("no clipboard");
        },
        async readText() {
          return "";
        },
      },
    });
    composer.insertText("draft");
    composer.handleAction("editor.cut-draft");
    await vi.waitFor(() => expect(composer.text).toBe(""));
    expect(onToast).toHaveBeenCalledWith("Draft cleared — clipboard unavailable");
  });

  it("clears with ctrl+x only when there is something to clear", () => {
    const onToast = vi.fn();
    const { composer } = controller({ onToast });
    expect(composer.handleAction("editor.clear")).toBe(false);
    composer.insertText("abc");
    expect(composer.handleAction("editor.clear")).toBe(true);
    expect(composer.text).toBe("");
    expect(onToast).toHaveBeenCalledWith("Draft cleared · ^Q");
  });
});

describe("composer frame under a paste", () => {
  it("asks for one row for a placeholder and many for raw text", () => {
    expect(composerTextRowsWanted({ columns: 80, text: "[500 lines pasted #1]" })).toBe(1);
    expect(composerTextRowsWanted({ columns: 80, text: BIG })).toBe(500);
  });

  it("never grants more rows than the allocator gave it", () => {
    const frame = composerFrame({
      columns: 80,
      allocatedRows: 6,
      text: BIG,
      mode: "agent",
      phase: "idle",
      unicode: true,
    });
    // 6 granted rows = 1 gap + 1 directory + 2 border + 2 text.
    expect(frame.textRows).toBe(2);
    expect(frame.showDirectory).toBe(true);
    expect(frame.width).toBe(80);
    expect(frame.textWidth).toBe(75);
  });

  it("locks the caret and the placeholder while input is suspended", () => {
    const frame = composerFrame({
      columns: 80,
      allocatedRows: 3,
      text: "",
      mode: "agent",
      phase: "suspended",
      unicode: true,
    });
    expect(frame.showCaret).toBe(false);
    expect(frame.placeholder).toBe("input locked");
  });
});
