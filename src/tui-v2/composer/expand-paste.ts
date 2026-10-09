import {
  resolveRenderLib,
  type TextareaRenderable,
  type WidthMethod,
} from "@opentui/core";
import type { PasteRegistry } from "../../ui-core/composer/paste-placeholder.js";
import { composerCharacterOffset, setComposerCharacterOffset } from "./composer-cursor.js";

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
  const next = registry.expandNearest(text, composerCharacterOffset(editor, text), id);
  if (!next) return false;
  editor.replaceText(next.text);
  setComposerCharacterOffset(editor, next.text, next.cursor, widthMethod);
  return true;
}
