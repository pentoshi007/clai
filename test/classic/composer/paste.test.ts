import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../../../src/app/commands/registry.js";
import type { ClipboardPort } from "../../../src/app/ports/clipboard-port.js";
import type { ClipboardImageCapture } from "../../../src/attachments/clipboard-image.js";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import { composerFrame, composerTextRowsWanted } from "../../../src/classic/chrome/composer-frame.js";
import { layoutEditor } from "../../../src/classic/chrome/editor-view.js";
import {
  formatAttachmentReference,
  stabilizeDroppedFilesInText,
} from "../../../src/ui/mentions.js";
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
  readonly baseDir?: string;
  readonly captureClipboardImage?: () => ClipboardImageCapture;
} = {}) {
  const commands = new CommandRegistry();
  commands.register({ name: "help", description: "show help" });
  return {
    commands,
    clipboard: overrides.clipboard ?? clipboard(),
    baseDir: overrides.baseDir ?? process.cwd(),
    onSubmit: overrides.onSubmit ?? vi.fn(),
    onToast: overrides.onToast ?? vi.fn(),
    onScrollChat: vi.fn(),
    onJumpTop: vi.fn(),
    captureClipboardImage: overrides.captureClipboardImage,
  };
}

const BIG = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
const PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clai-classic-paste-"));
  dirs.push(dir);
  return dir;
}

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

describe("classic attachment paste", () => {
  it("rewrites an existing file drop to a file URL", () => {
    const dir = tempDir();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "notes");
    const result = stabilizeDroppedFilesInText(file, dir);
    expect(result.files).toEqual([file]);
    expect(result.images).toEqual([]);
    expect(result.text).toBe(formatAttachmentReference(file, dir));
  });

  it("rewrites multiple files and stabilizes image drops", () => {
    const dir = tempDir();
    const text = join(dir, "notes.txt");
    const image = join(dir, "shot.png");
    writeFileSync(text, "notes");
    writeFileSync(image, Buffer.from(PNG_HEX, "hex"));
    const result = stabilizeDroppedFilesInText(`${text} ${image}`, dir);
    expect(result.files).toHaveLength(2);
    expect(result.images).toHaveLength(1);
    expect(result.text).toContain("file://");
    expect(result.text).toContain(formatAttachmentReference(text, dir));
    expect(result.text).not.toContain(image);
    expect(existsSync(result.images[0]!)).toBe(true);
  });

  it("handles quoted and escaped-space paths while leaving prose alone", () => {
    const dir = tempDir();
    const file = join(dir, "my shot.txt");
    writeFileSync(file, "notes");
    const quoted = stabilizeDroppedFilesInText(`\"${file}\"`, dir);
    const escaped = stabilizeDroppedFilesInText(file.replace(/ /g, "\\ "), dir);
    expect(quoted.files).toEqual([file]);
    expect(quoted.text).toContain(formatAttachmentReference(file, dir));
    expect(escaped.files).toEqual([file]);
    expect(escaped.text).toContain(formatAttachmentReference(file, dir));
    expect(stabilizeDroppedFilesInText(`${file} ${"words ".repeat(100)}`, dir).files).toEqual([]);
  });

  it("captures an image when an empty paste is received", async () => {
    const path = "/tmp/clipboard-image.png";
    const capture = vi.fn((): ClipboardImageCapture => ({
      ok: true,
      path,
      mediaType: "image/png",
      byteLength: 10,
    }));
    const { composer, deps } = controller({ captureClipboardImage: capture });
    composer.paste("");
    await vi.waitFor(() => expect(composer.text).toContain(formatAttachmentReference(path, deps.baseDir)));
    expect(capture).toHaveBeenCalledOnce();
  });

  it("reports clipboard image capture failures without changing the draft", async () => {
    const onToast = vi.fn();
    const { composer } = controller({
      onToast,
      captureClipboardImage: () => ({ ok: false, reason: "No image in clipboard" }),
    });
    composer.insertText("draft");
    composer.paste("");
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("No image in clipboard"));
    expect(composer.text).toBe("draft");
  });

  it("uses clipboard text for ctrl+v and falls back to image capture", async () => {
    const textBoard: ClipboardPort = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => "from clipboard"),
    };
    const textCase = controller({ clipboard: textBoard });
    expect(textCase.composer.handleChord("ctrl+v")).toBe(true);
    await vi.waitFor(() => expect(textCase.composer.text).toBe("from clipboard"));

    const capture = vi.fn((): ClipboardImageCapture => ({
      ok: true,
      path: "/tmp/clipboard-image.png",
      mediaType: "image/png",
      byteLength: 10,
    }));
    const imageBoard: ClipboardPort = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => ""),
    };
    const imageCase = controller({ clipboard: imageBoard, captureClipboardImage: capture });
    expect(imageCase.composer.handleChord("ctrl+v")).toBe(true);
    await vi.waitFor(() => expect(imageCase.composer.text).toContain("file://"));
    expect(capture).toHaveBeenCalledOnce();
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
