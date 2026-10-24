import { captureClipboardImage } from "../../attachments/clipboard-image.js";
import { formatAttachmentReference, stabilizeDroppedFilesInText } from "../../ui/mentions.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { notify } from "../notify.js";
import { isLargePaste, type PasteRegistry } from "./paste-placeholder.js";

interface ComposerEditor {
  readonly plainText: string;
  readonly cursorOffset: number;
  insertText(text: string): void;
  focus(): void;
}

interface EditorRef {
  readonly current: ComposerEditor | null;
}

interface PreventableEvent {
  preventDefault(): void;
}

interface ComposerImagePaste {
  handleChord(chord: string, overlayKind: string, key: PreventableEvent): boolean;
  handlePaste(text: string, event: PreventableEvent): boolean;
  handleDroppedImages(text: string, event: PreventableEvent): boolean;
}

const activePastes = new WeakSet<AppServices>();

export function createComposerImagePaste(
  services: AppServices,
  editorRef: EditorRef,
  refresh: () => void,
  registry?: PasteRegistry,
): ComposerImagePaste {
  const insert = (text: string, attachment = true): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const before = editor.plainText[editor.cursorOffset - 1] ?? "";
    const leadingSpace = before && !/\s/.test(before) ? " " : "";
    editor.insertText(attachment ? `${leadingSpace}${registry?.compactAttachments(text) ?? text} ` : text);
    services.focus.focusRegion("composer");
    editor.focus();
    queueMicrotask(refresh);
  };

  const pasteClipboard = (readText: boolean): void => {
    if (activePastes.has(services)) return;
    activePastes.add(services);
    const editor = editorRef.current;
    const generation = registry?.generation;
    const current = (): boolean => editor !== null && editorRef.current === editor && generation === registry?.generation;
    void (async () => {
      const text = readText ? await services.ports.clipboard.readText?.().catch(() => undefined) : undefined;
      if (!current()) return;
      if (text && text.length > 0) {
        const normalized = text.replace(/\r\n?/g, "\n");
        const dropped = stabilizeDroppedFilesInText(normalized);
        const value = dropped.files.length > 0 ? dropped.text
          : registry && isLargePaste(normalized) ? registry.register(normalized).token : normalized;
        insert(value, dropped.files.length > 0);
        return;
      }
      const result = await captureClipboardImage();
      if (!current()) return;
      if (!result.ok) {
        notify(services, result.reason, { key: "image-paste", level: "warn", durationMs: 2600 });
        return;
      }
      insert(formatAttachmentReference(result.path));
      notify(services, "Image attached from clipboard", { key: "image-paste", durationMs: 1600 });
    })().catch(() => {
      if (current()) notify(services, "Clipboard image could not be read.", { key: "image-paste", level: "warn" });
    }).finally(() => { activePastes.delete(services); });
  };

  return {
    handleChord(chord, overlayKind, key) {
      if (overlayKind !== "none" || chord !== "ctrl+v") return false;
      key.preventDefault();
      pasteClipboard(true);
      return true;
    },
    handlePaste(text, event) {
      if (text.length > 0) return false;
      event.preventDefault();
      pasteClipboard(false);
      return true;
    },
    handleDroppedImages(text, event) {
      if (!text.trim()) return false;
      const dropped = stabilizeDroppedFilesInText(text);
      if (dropped.files.length === 0) return false;
      event.preventDefault();
      insert(dropped.text);
      notify(services, dropped.files.length > 1 ? `${dropped.files.length} files attached`
        : dropped.images.length ? "Image attached" : "File attached", { key: "image-paste", durationMs: 1600 });
      return true;
    },
  };
}
