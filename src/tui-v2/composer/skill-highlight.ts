import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { findSkillMentions } from "../../skills/mentions.js";

const STYLE_NAME = "clai.skill.mention";

let style: SyntaxStyle | undefined;
let styleId: number | undefined;
let styleColor: string | undefined;
let unsupported = false;

function ensureStyle(color: string): boolean {
  if (unsupported) return false;
  if (style && styleId !== undefined && styleColor === color) return true;
  try {
    style = SyntaxStyle.fromStyles({
      [STYLE_NAME]: { fg: color, bold: true },
    });
    styleId = style.resolveStyleId(STYLE_NAME) ?? undefined;
    styleColor = color;
    if (styleId === undefined) {
      unsupported = true;
      return false;
    }
    return true;
  } catch {
    unsupported = true;
    style = undefined;
    styleId = undefined;
    return false;
  }
}

export function skillHighlightSupported(): boolean {
  return !unsupported;
}

export function paintSkillMentions(
  editor: TextareaRenderable | null,
  known: ReadonlySet<string>,
  color: string,
): void {
  if (!editor || unsupported) return;
  const text = editor.plainText;
  const ranges = findSkillMentions(text, known);
  if (ranges.length === 0 && !style) return;
  if (!ensureStyle(color)) return;
  try {
    editor.clearAllHighlights();
    if (ranges.length === 0) return;
    if (editor.syntaxStyle !== style) editor.syntaxStyle = style!;
    for (const range of ranges) {
      editor.addHighlightByCharRange({
        start: range.start,
        end: range.end,
        styleId: styleId!,
        priority: 100,
      });
    }
  } catch {
    unsupported = true;
  }
}
