/**
 * Semantic, source-order text extraction for transcript selection and export.
 *
 * This deliberately operates on normalized items rather than terminal cells:
 * Markdown wrapping, syntax color, and viewport culling cannot alter copied
 * content. Optional tool output is injected by the caller so spool ownership
 * remains outside transcript state.
 */

import {
  isItemExpanded,
  transcriptItems,
  type ToolItem,
  type TranscriptState,
} from "../state/transcript-types.js";
import type { SemanticDocument } from "../state/semantic-document.js";
import { SEMANTIC_BLOCK_SEPARATOR } from "../state/semantic-document.js";
import { presentTool } from "./tool-presenter.js";

export type ThinkingInclusion = "none" | "visible" | "all";

export interface TranscriptSemanticOptions {
  readonly thinking?: ThinkingInclusion;
  readonly toolOutput?: (item: ToolItem) => string | undefined;
}

export function extractTranscriptSemanticDocument(
  state: TranscriptState,
  options: TranscriptSemanticOptions = {},
): SemanticDocument {
  const thinking = options.thinking ?? "visible";
  const blocks = [] as Array<{ id: string; text: string }>;

  for (const item of transcriptItems(state)) {
    if (item.kind === "thinking" && !includeThinking(state, item.id, thinking)) continue;
    blocks.push({ id: item.id, text: semanticTextForItem(item, options.toolOutput) });
  }
  return { blocks };
}

export function renderTranscriptSemanticText(
  state: TranscriptState,
  options: TranscriptSemanticOptions = {},
): string {
  return extractTranscriptSemanticDocument(state, options).blocks
    .map((block) => block.text)
    .join(SEMANTIC_BLOCK_SEPARATOR);
}

function includeThinking(
  state: TranscriptState,
  itemId: string,
  inclusion: ThinkingInclusion,
): boolean {
  if (inclusion === "all") return true;
  if (inclusion === "none") return false;
  const item = state.byId.get(itemId);
  return item?.kind === "thinking" && isItemExpanded(state, item);
}

function semanticTextForItem(
  item: ReturnType<typeof transcriptItems>[number],
  toolOutput: TranscriptSemanticOptions["toolOutput"],
): string {
  switch (item.kind) {
    case "user":
      return `You:\n${item.text}`;
    case "assistant":
      return `Assistant:\n${item.text}`;
    case "thinking":
      return `Thinking:\n${item.content}`;
    case "tool": {
      const { statusLabel, name, argsDisplay, detail } = presentTool(item);
      const headline = argsDisplay ? `${name} ${argsDisplay}` : name;
      // UI cards hide full model-context summaries; export still includes
      // summary text, then any live spool the caller injects.
      return [
        `Tool: ${headline} — ${statusLabel}`,
        item.status === "blocked" ? detail : item.summary,
        item.artifactPath ? `  artifact: ${item.artifactPath}` : undefined,
        toolOutput?.(item),
      ]
        .filter((part): part is string => part !== undefined && part !== "")
        .join("\n");
    }
    case "notice":
      return `[${item.level}] ${item.text}`;
    case "compacted":
      return `[compacted context: ~${item.beforeTokens} -> ~${item.afterTokens} tokens]\n${item.summary}`;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}
