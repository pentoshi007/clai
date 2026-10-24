import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClipboardImage, type ClipboardImageCapture } from "../../src/attachments/clipboard-image.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createComposerImagePaste } from "../../src/tui-v2/composer/composer-image-paste.js";
import { PasteRegistry } from "../../src/ui-core/composer/paste-placeholder.js";
import { formatAttachmentReference } from "../../src/ui/mentions.js";

vi.mock("../../src/attachments/clipboard-image.js", () => ({ captureClipboardImage: vi.fn() }));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.resetAllMocks();
});

function setup(text = "") {
  const services = createCompositionRoot({ noHistory: true,
    clipboard: { writeText: async () => {}, readText: async () => text },
    persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
  });
  cleanups.push(() => services.dispose());
  const editor = { plainText: "", cursorOffset: 0,
    insertText(value: string) {
      this.plainText = this.plainText.slice(0, this.cursorOffset) + value + this.plainText.slice(this.cursorOffset);
      this.cursorOffset += value.length;
    },
    focus: vi.fn(),
  };
  const registry = new PasteRegistry();
  const refresh = vi.fn();
  const ref = { current: editor };
  const paste = createComposerImagePaste(services, ref, refresh, registry);
  const event = { preventDefault: vi.fn() };
  return { paste, editor, registry, refresh, event, ref };
}

describe("v2 attachment paste", () => {
  it("uses short labels for image and PDF paths and preserves their references", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-v2-attachment-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const image = join(dir, "my shot.png");
    const pdf = join(dir, "report.pdf");
    writeFileSync(image, "image");
    writeFileSync(pdf, "%PDF");
    const { paste, editor, registry, event } = setup();
    expect(paste.handleDroppedImages(`"${image}" ${pdf}`, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(editor.plainText).toBe("[Image 1] [File 2: report.pdf] ");
    expect(registry.expand(editor.plainText)).toBe(`${formatAttachmentReference(image)} ${formatAttachmentReference(pdf)} `);
  });

  it("does not block typing or duplicate captures while clipboard work is pending", async () => {
    let release!: (capture: ClipboardImageCapture) => void;
    vi.mocked(captureClipboardImage).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { paste, editor, event } = setup();
    paste.handlePaste("", event);
    paste.handlePaste("", event);
    editor.insertText("typing");
    expect(editor.plainText).toBe("typing");
    release({ ok: true, path: "/tmp/shot.png", mediaType: "image/png", byteLength: 10 });
    await vi.waitFor(() => expect(editor.plainText).toBe("typing [Image 1] "));
    expect(captureClipboardImage).toHaveBeenCalledOnce();
  });

  it("does not add a late clipboard image to a cleared or sent draft", async () => {
    let release!: (capture: ClipboardImageCapture) => void;
    vi.mocked(captureClipboardImage).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { paste, editor, registry, event } = setup();
    paste.handlePaste("", event);
    registry.clear();
    release({ ok: true, path: "/tmp/late.png", mediaType: "image/png", byteLength: 10 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(editor.plainText).toBe("");
  });

  it("reads clipboard text before trying raw image capture", async () => {
    const { paste, editor, event } = setup("clipboard text");
    expect(paste.handleChord("ctrl+v", "none", event)).toBe(true);
    await vi.waitFor(() => expect(editor.plainText).toBe("clipboard text"));
    expect(captureClipboardImage).not.toHaveBeenCalled();
  });
});

it("preserves ordinary clipboard text, whitespace, and insertion position", async () => {
  const { paste, editor, event } = setup(" before\r\nafter ");
  editor.plainText = "left|right";
  editor.cursorOffset = 4;
  paste.handleChord("ctrl+v", "none", event);
  await vi.waitFor(() => expect(editor.plainText).toBe("left before\nafter |right"));
  expect(captureClipboardImage).not.toHaveBeenCalled();
});

it("preserves whitespace-only clipboard text and lets native whitespace paste through", async () => {
  const { paste, editor, event } = setup(" \t");
  expect(paste.handlePaste(" \n", event)).toBe(false);
  expect(event.preventDefault).not.toHaveBeenCalled();
  paste.handleChord("ctrl+v", "none", event);
  await vi.waitFor(() => expect(editor.plainText).toBe(" \t"));
  expect(captureClipboardImage).not.toHaveBeenCalled();
});
