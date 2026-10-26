import { SyntaxStyle, TextBuffer, type TextareaRenderable, type WidthMethod } from "@opentui/core";
import { findMcpMentions } from "../../mcp/mentions.js";
import { findReaMentions } from "../../rea/workflow.js";
import { findSkillMentions } from "../../skills/mentions.js";

export type MentionKind = "skill" | "mcp" | "paste";

export interface MentionPaint {
  readonly kind: MentionKind;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly color: string;
}

const STYLE_NAMES: Record<MentionKind, string> = {
  skill: "clai.skill.mention",
  mcp: "clai.mcp.mention",
  paste: "clai.paste.placeholder",
};

let style: SyntaxStyle | undefined;
let styleIds: Partial<Record<MentionKind, number>> = {};
let styleSignature: string | undefined;
let unsupported = false;

function ensureStyle(colors: Record<MentionKind, string>): boolean {
  if (unsupported) return false;
  const signature = `${colors.skill}|${colors.mcp}|${colors.paste}`;
  if (style && styleSignature === signature) return true;
  try {
    style = SyntaxStyle.fromStyles({
      [STYLE_NAMES.skill]: { fg: colors.skill, bold: true },
      [STYLE_NAMES.mcp]: { fg: colors.mcp, bold: true },
      [STYLE_NAMES.paste]: { fg: colors.paste, bold: true },
    });
    const ids: Partial<Record<MentionKind, number>> = {};
    for (const kind of Object.keys(STYLE_NAMES) as MentionKind[]) {
      const id = style.resolveStyleId(STYLE_NAMES[kind]);
      if (id === undefined || id === null) {
        unsupported = true;
        style = undefined;
        styleIds = {};
        return false;
      }
      ids[kind] = id;
    }
    styleIds = ids;
    styleSignature = signature;
    return true;
  } catch {
    unsupported = true;
    style = undefined;
    styleIds = {};
    return false;
  }
}

export function mentionHighlightSupported(): boolean {
  return !unsupported;
}

export function paintComposerMentions(
  editor: TextareaRenderable | null,
  paints: readonly MentionPaint[],
): void {
  if (!editor || unsupported) return;
  const total = paints.reduce((sum, paint) => sum + paint.ranges.length, 0);
  if (total === 0 && !style) return;
  const colors: Record<MentionKind, string> = { skill: "", mcp: "", paste: "" };
  for (const paint of paints) colors[paint.kind] = paint.color;
  if (!ensureStyle(colors)) return;
  try {
    editor.clearAllHighlights();
    if (total === 0) return;
    if (editor.syntaxStyle !== style) editor.syntaxStyle = style!;
    for (const paint of paints) {
      const styleId = styleIds[paint.kind];
      if (styleId === undefined) continue;
      for (const range of paint.ranges) {
        editor.addHighlightByCharRange({
          start: range.start,
          end: range.end,
          styleId,
          priority: 100,
        });
      }
    }
  } catch {
    unsupported = true;
  }
}

function bufferPaintRanges(
  text: string,
  paints: readonly MentionPaint[],
  widthMethod: WidthMethod,
): readonly MentionPaint[] {
  const boundaries = [...new Set(paints.flatMap((paint) => paint.ranges.flatMap((range) => [range.start, range.end])))].sort((a, b) => a - b);
  if (boundaries.length === 0 || /^[\x20-\x7e]*$/.test(text)) return paints;
  const offsets = new Map<number, number>();
  const measure = TextBuffer.create(widthMethod);
  try {
    let previous = 0;
    for (const boundary of boundaries) {
      measure.append(text.slice(previous, boundary));
      offsets.set(boundary, measure.length);
      previous = boundary;
    }
  } finally {
    measure.destroy();
  }
  return paints.map((paint) => ({
    ...paint,
    ranges: paint.ranges.map((range) => ({ start: offsets.get(range.start)!, end: offsets.get(range.end)! })),
  }));
}

export function paintDraftMentions(input: {
  readonly editor: TextareaRenderable | null;
  readonly text: string;
  readonly widthMethod: WidthMethod;
  readonly skills: ReadonlySet<string>;
  readonly skillColor: string;
  readonly servers: ReadonlySet<string>;
  readonly serverColor: string;
  readonly pasteRanges?: readonly { readonly start: number; readonly end: number }[];
  readonly pasteColor?: string;
}): void {
  paintComposerMentions(input.editor, bufferPaintRanges(input.text, [
    {
      kind: "skill",
      ranges: findSkillMentions(input.text, input.skills),
      color: input.skillColor,
    },
    {
      kind: "mcp",
      ranges: [...findMcpMentions(input.text, input.servers), ...findReaMentions(input.text)],
      color: input.serverColor,
    },
    {
      kind: "paste",
      ranges: input.pasteRanges ?? [],
      color: input.pasteColor ?? input.serverColor,
    },
  ], input.widthMethod));
}
