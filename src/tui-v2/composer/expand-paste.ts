import {
  resolveRenderLib,
  TextBuffer,
  type TextareaRenderable,
  type WidthMethod,
} from "@opentui/core";
import { countLines, type PasteRegistry } from "../../ui-core/composer/paste-placeholder.js";

const decoder = new TextDecoder();

export function retainComposerText(editor: TextareaRenderable | null): () => void {
  if (!editor) return () => undefined;
  const buffer = editor.editBuffer;
  const lib = resolveRenderLib();
  const textBuffer = lib.editBufferGetTextBuffer(buffer.ptr);
  const original = buffer.getText;
  buffer.getText = () => {
    const pointer = buffer.ptr;
    const size = lib.textBufferGetByteSize(textBuffer);
    if (size <= 1024 * 1024) return original.call(buffer);
    const bytes = lib.editBufferGetText(pointer, size);
    return bytes ? decoder.decode(bytes) : "";
  };
  return () => {
    buffer.getText = original;
  };
}

export function expandComposerPaste(
  editor: TextareaRenderable,
  registry: PasteRegistry,
  widthMethod: WidthMethod,
  id?: number,
): boolean {
  const text = editor.plainText;
  if (registry.activeIn(text).length === 0) return false;
  const offset = editor.cursorOffset;
  const bytes = offset > 0
    ? resolveRenderLib().editBufferGetTextRange(editor.editBuffer.ptr, 0, offset, Buffer.byteLength(text))
    : undefined;
  if (offset > 0 && !bytes) return false;
  const next = registry.expandNearest(text, bytes ? decoder.decode(bytes).length : 0, id);
  if (!next) return false;
  const prefix = next.text.slice(0, next.cursor);
  const row = Math.max(0, countLines(prefix) - 1);
  const measure = TextBuffer.create(widthMethod);
  try {
    measure.setText(prefix.slice(prefix.lastIndexOf("\n") + 1));
    editor.replaceText(next.text);
    editor.setCursor(row, measure.length);
  } finally {
    measure.destroy();
  }
  return true;
}
