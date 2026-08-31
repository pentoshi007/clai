
import { TextRenderable, stringToStyledText, StyledText } from "@opentui/core";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";

let patched = false;

function isStyledText(value: unknown): value is StyledText {
  return (
    value instanceof StyledText ||
    (typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { chunks?: unknown }).chunks))
  );
}

export function sanitizeOpenTuiTextContent(value: unknown): string | StyledText {
  if (value == null) return " ";
  if (typeof value === "string") {
    const sanitized = sanitizeDisplayText(value);
    return sanitized.length === 0 ? " " : sanitized;
  }
  if (isStyledText(value)) {
    if (!value.chunks || value.chunks.length === 0) return " ";
    let changed = false;
    const chunks = value.chunks.map((chunk) => {
      const sanitized = sanitizeDisplayText(chunk.text);
      if (sanitized === chunk.text) return chunk;
      changed = true;
      return { ...chunk, text: sanitized };
    });
    if (chunks.every((chunk) => chunk.text.length === 0)) return " ";
    return changed ? new StyledText(chunks) : value;
  }
  try {
    const sanitized = sanitizeDisplayText(String(value));
    return stringToStyledText(sanitized.length === 0 ? " " : sanitized);
  } catch {
    return " ";
  }
}

export function patchOpenTuiTextContent(): void {
  if (patched) return;
  patched = true;

  const proto = TextRenderable.prototype as unknown as {
    content: unknown;
  };
  const desc = Object.getOwnPropertyDescriptor(proto, "content");
  if (!desc?.set || !desc.get) return;

  const originalSet = desc.set;
  Object.defineProperty(proto, "content", {
    configurable: true,
    enumerable: desc.enumerable ?? true,
    get: desc.get,
    set(value: unknown) {
      originalSet.call(this, sanitizeOpenTuiTextContent(value));
    },
  });
}
