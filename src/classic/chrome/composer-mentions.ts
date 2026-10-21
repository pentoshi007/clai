import { findSkillMentions } from "../../skills/mentions.js";
import { findMcpMentions } from "../../mcp/mentions.js";
import { findReaMentions } from "../../rea/workflow.js";
import type { EditorSpan } from "./editor-view.js";

export function composerMentionSpans(text: string, skills: ReadonlySet<string>, servers: ReadonlySet<string>): EditorSpan[] {
  return [
    ...findSkillMentions(text, skills).map((mention) => ({
      start: mention.start,
      end: mention.end,
    })),
    ...[...findMcpMentions(text, servers), ...findReaMentions(text)].map((mention) => ({
      start: mention.start,
      end: mention.end,
      color: "aqua" as const,
    })),
  ];
}
