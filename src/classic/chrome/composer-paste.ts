import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import { captureClipboardImage, type ClipboardImageCapture } from "../../attachments/clipboard-image.js";
import { formatAttachmentReference, stabilizeDroppedFilesInText } from "../../ui/mentions.js";
import { isLargePaste, type PasteRegistry } from "../../ui-core/composer/paste-placeholder.js";
import type { EditorState } from "./editor-model.js";

interface ComposerPasteDeps {
  readonly clipboard: ClipboardPort;
  readonly baseDir?: string | undefined;
  readonly captureClipboardImage?: (() => ClipboardImageCapture | Promise<ClipboardImageCapture>) | undefined;
  readonly onToast: (text: string) => void;
}

export class ComposerPaste {
  private generation = 0;
  private readingClipboard = false;

  constructor(
    private readonly deps: ComposerPasteDeps,
    private readonly registry: PasteRegistry,
    private readonly getState: () => EditorState,
    private readonly insertText: (text: string) => void,
  ) {}

  invalidate(): void {
    this.generation += 1;
  }

  paste(text: string): void {
    if (text.length === 0) {
      void this.readClipboard(false);
      return;
    }
    const normalized = text.replace(/\r\n?/g, "\n");
    const dropped = stabilizeDroppedFilesInText(normalized, this.deps.baseDir ?? process.cwd());
    if (dropped.files.length > 0) {
      this.insertAttachment(dropped.text);
      const label = dropped.images.length === 1 ? "Image attached" : "File attached";
      this.deps.onToast(dropped.files.length > 1 ? `${dropped.files.length} files attached` : label);
      return;
    }
    this.insertText(isLargePaste(normalized) ? this.registry.register(normalized).token : normalized);
  }

  pasteClipboard(): void {
    void this.readClipboard(true);
  }

  private insertAttachment(text: string): void {
    const state = this.getState();
    const before = state.text[state.cursor - 1] ?? "";
    const leadingSpace = before && !/\s/.test(before) ? " " : "";
    this.insertText(`${leadingSpace}${this.registry.compactAttachments(text.trim())} `);
  }

  private async readClipboard(readText: boolean): Promise<void> {
    if (this.readingClipboard) return;
    this.readingClipboard = true;
    const generation = this.generation;
    try {
      const text = readText ? await this.deps.clipboard.readText?.().catch(() => undefined) : undefined;
      if (generation !== this.generation) return;
      if (text) {
        this.paste(text);
        return;
      }
      const capture = this.deps.captureClipboardImage ?? (() => captureClipboardImage(this.deps.baseDir));
      const result = await capture();
      if (generation !== this.generation) return;
      if (!result.ok) {
        this.deps.onToast(result.reason);
        return;
      }
      this.insertAttachment(formatAttachmentReference(result.path, this.deps.baseDir));
      this.deps.onToast("Image attached from clipboard");
    } catch {
      if (generation === this.generation) this.deps.onToast("Clipboard image could not be read.");
    } finally {
      this.readingClipboard = false;
    }
  }
}
