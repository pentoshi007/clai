
import {
  isItemExpanded,
  transcriptItems,
  type ToolItem,
  type TranscriptState,
} from "../state/transcript-types.js";
import type { SemanticBlock, SemanticDocument } from "../state/semantic-document.js";
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
  const blocks: SemanticBlock[] = [];

  for (const item of transcriptItems(state)) {
    if (item.kind === "notice") continue;
    if (item.kind === "thinking" && !includeThinking(state, item.id, thinking)) continue;
    blocks.push(semanticBlockForItem(item, options.toolOutput));
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

type SemanticItem = ReturnType<typeof transcriptItems>[number];

const semanticBlocks = new WeakMap<
  SemanticItem,
  { readonly output: string | undefined; readonly block: SemanticBlock }
>();

function semanticBlockForItem(
  item: SemanticItem,
  toolOutput: TranscriptSemanticOptions["toolOutput"],
): SemanticBlock {
  const output = item.kind === "tool" ? toolOutput?.(item) : undefined;
  const cached = semanticBlocks.get(item);
  if (cached && cached.output === output) return cached.block;
  const block = { id: item.id, text: semanticTextForItem(item, () => output) };
  semanticBlocks.set(item, { output, block });
  return block;
}

function semanticTextForItem(
  item: SemanticItem,
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
      return "";
    case "compacted":
      return `[compacted context: ~${item.beforeTokens} -> ~${item.afterTokens} tokens]\n${item.summary}`;
    case "turn-summary":
      return "";
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}
