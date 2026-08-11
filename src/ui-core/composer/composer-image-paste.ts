import { captureClipboardImage } from "../../attachments/clipboard-image.js";
import {
  formatAttachmentReference,
  stabilizeDroppedImagesInText,
} from "../../ui/mentions.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { notify } from "../../ui-core/notify.js";

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
  handleChord(
    chord: string,
    overlayKind: string,
    key: PreventableEvent,
  ): boolean;
  handlePaste(text: string, event: PreventableEvent): boolean;
  handleDroppedImages(text: string, event: PreventableEvent): boolean;
}

const activePastes = new WeakSet<AppServices>();

export function createComposerImagePaste(
  services: AppServices,
  editorRef: EditorRef,
  refresh: () => void,
): ComposerImagePaste {
  const pasteImage = (): void => {
    if (activePastes.has(services)) return;
    activePastes.add(services);
    setImmediate(() => {
      const result = captureClipboardImage();
      activePastes.delete(services);
      if (!result.ok) {
        notify(services, result.reason, {
          key: "image-paste",
          level: "warn",
          durationMs: 2600,
        });
        return;
      }
      const editor = editorRef.current;
      if (!editor) return;
      const before = editor.plainText[editor.cursorOffset - 1] ?? "";
      const leadingSpace = before && !/\s/.test(before) ? " " : "";
      const reference = formatAttachmentReference(result.path);
      editor.insertText(`${leadingSpace}${reference} `);
      services.focus.focusRegion("composer");
      editor.focus();
      notify(services, "Image attached from clipboard", {
        key: "image-paste",
        durationMs: 1600,
      });
      queueMicrotask(refresh);
    });
  };

  return {
    handleChord(chord, overlayKind, key) {
      if (overlayKind !== "none" || chord !== "ctrl+v") return false;
      key.preventDefault();
      services.focus.focusRegion("composer");
      editorRef.current?.focus();
      pasteImage();
      return true;
    },
    handlePaste(text, event) {
      if (text.trim()) return false;
      event.preventDefault();
      pasteImage();
      return true;
    },
    handleDroppedImages(text, event) {
      if (!text.trim()) return false;
      const { text: rewritten, images } = stabilizeDroppedImagesInText(text);
      if (images.length === 0) return false;
      event.preventDefault();
      const editor = editorRef.current;
      if (!editor) return true;
      const before = editor.plainText[editor.cursorOffset - 1] ?? "";
      const leadingSpace = before && !/\s/.test(before) ? " " : "";
      editor.insertText(`${leadingSpace}${rewritten} `);
      services.focus.focusRegion("composer");
      editor.focus();
      notify(
        services,
        images.length > 1
          ? `${images.length} images attached`
          : "Image attached",
        { key: "image-paste", durationMs: 1600 },
      );
      queueMicrotask(refresh);
      return true;
    },
  };
}
