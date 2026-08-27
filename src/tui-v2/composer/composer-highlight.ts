import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { findMcpMentions } from "../../mcp/mentions.js";
import { findSkillMentions } from "../../skills/mentions.js";

export type MentionKind = "skill" | "mcp";

export interface MentionPaint {
  readonly kind: MentionKind;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly color: string;
}

const STYLE_NAMES: Record<MentionKind, string> = {
  skill: "clai.skill.mention",
  mcp: "clai.mcp.mention",
};

let style: SyntaxStyle | undefined;
let styleIds: Partial<Record<MentionKind, number>> = {};
let styleSignature: string | undefined;
let unsupported = false;

function ensureStyle(colors: Record<MentionKind, string>): boolean {
  if (unsupported) return false;
  const signature = `${colors.skill}|${colors.mcp}`;
  if (style && styleSignature === signature) return true;
  try {
    style = SyntaxStyle.fromStyles({
      [STYLE_NAMES.skill]: { fg: colors.skill, bold: true },
      [STYLE_NAMES.mcp]: { fg: colors.mcp, bold: true },
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
  const colors: Record<MentionKind, string> = { skill: "", mcp: "" };
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

export function paintDraftMentions(input: {
  readonly editor: TextareaRenderable | null;
  readonly text: string;
  readonly skills: ReadonlySet<string>;
  readonly skillColor: string;
  readonly servers: ReadonlySet<string>;
  readonly serverColor: string;
}): void {
  paintComposerMentions(input.editor, [
    {
      kind: "skill",
      ranges: findSkillMentions(input.text, input.skills),
      color: input.skillColor,
    },
    {
      kind: "mcp",
      ranges: findMcpMentions(input.text, input.servers),
      color: input.serverColor,
    },
  ]);
}
