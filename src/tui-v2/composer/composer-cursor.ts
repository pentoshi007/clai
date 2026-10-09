import {
  resolveRenderLib,
  TextBuffer,
  type TextareaRenderable,
  type WidthMethod,
} from "@opentui/core";
import { countLines } from "../../ui-core/composer/paste-placeholder.js";

const decoder = new TextDecoder();

export function composerCharacterOffset(editor: TextareaRenderable, text = editor.plainText): number {
  if (editor.cursorOffset <= 0) return 0;
  const bytes = resolveRenderLib().editBufferGetTextRange(
    editor.editBuffer.ptr,
    0,
    editor.cursorOffset,
    Buffer.byteLength(text),
  );
  return bytes ? decoder.decode(bytes).length : 0;
}

export function setComposerCharacterOffset(
  editor: TextareaRenderable,
  text: string,
  offset: number,
  widthMethod: WidthMethod,
): void {
  const prefix = text.slice(0, Math.max(0, Math.min(text.length, offset)));
  const measure = TextBuffer.create(widthMethod);
  try {
    measure.setText(prefix.slice(prefix.lastIndexOf("\n") + 1));
    editor.setCursor(Math.max(0, countLines(prefix) - 1), measure.length);
  } finally {
    measure.destroy();
  }
}
