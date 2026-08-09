// Live reasoning can run to tens of thousands of chars. While it streams, only
// a bounded tail is painted so per-frame wrap work stays constant; the finalized
// block still shows the full content.

export const LIVE_THINKING_TAIL_CHARS = 2_000;

export function liveThinkingTail(
  content: string,
  limit = LIVE_THINKING_TAIL_CHARS,
): string {
  if (content.length <= limit) return content;
  const slice = content.slice(content.length - limit);
  const newline = slice.indexOf("\n");
  const aligned = newline >= 0 && newline < 200 ? slice.slice(newline + 1) : slice;
  return `…\n${aligned}`;
}

import { stripToolCallSurfaces } from "./strip-tool-surfaces.js";

const SURFACE_OPENERS = [
  "<|DSML",
  "<｜DSML",
  "```tool",
  "```json tool",
  "<tool_call",
  "\ntool_call(",
  "\ninvoke_tool(",
  "<|tool_calls_section_begin|>",
  "<|tool_call_begin|>",
  "<|tool▁calls▁begin|>",
  "<｜tool▁calls▁begin｜>",
  "<｜tool▁call▁begin｜>",
  "<｜tool▁sep｜>",
];

export function liveThinkingDisplay(
  content: string,
  limit = LIVE_THINKING_TAIL_CHARS,
): string {
  if (!SURFACE_OPENERS.some((opener) => content.includes(opener))) {
    return liveThinkingTail(content, limit);
  }
  const stripped = stripToolCallSurfaces(content);
  if (!stripped.trim()) return "…";
  return liveThinkingTail(stripped, limit);
}

export const LIVE_COMPACTION_HEAD_CHARS = 1_500;
export const LIVE_COMPACTION_TAIL_CHARS = 2_500;

export function liveCompactionHeadTail(
  content: string,
  headLimit = LIVE_COMPACTION_HEAD_CHARS,
  tailLimit = LIVE_COMPACTION_TAIL_CHARS,
): string {
  if (content.length <= headLimit + tailLimit) return content;
  const rawHead = content.slice(0, headLimit);
  const headBreak = rawHead.lastIndexOf("\n");
  const head = headBreak > headLimit / 2 ? rawHead.slice(0, headBreak) : rawHead;
  const rawTail = content.slice(content.length - tailLimit);
  const tailBreak = rawTail.indexOf("\n");
  const tail = tailBreak >= 0 && tailBreak < 200 ? rawTail.slice(tailBreak + 1) : rawTail;
  return `${head}\n\n… streaming middle omitted …\n\n${tail}`;
}