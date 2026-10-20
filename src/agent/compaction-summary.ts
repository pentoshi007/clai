import { stripReasoningMarkers } from "../llm/reasoning-marker.js";
import { requestTokenCalibration } from "../llm/token-estimate-calibration.js";
import type { ProviderId } from "../types.js";

export {
  buildCompactionChunkPrompt,
  buildCompactionReducePrompt,
  buildCompactionRetryPrompt,
  buildCompactionUserPrompt,
  buildDirectCompactionPrompt,
  compactionSituation,
  COMPACTION_SYSTEM_PROMPT,
  type CompactionPromptInput,
  type CompactionPurpose,
  type CompactionRetryReason,
  type CompactionSituation,
  type CompactionSource,
} from "./compaction/compaction-prompt.js";

export const COMPACTION_TRANSCRIPT_CHAR_BUDGET = 48_000;

export const COMPACTION_MAX_COMPLETION_TOKENS = 12_288;

export const COMPACTION_INPUT_SAFETY_TOKENS = 4_096;

export function compactionSinglePassInputBudget(
  contextLimitTokens: number,
): number {
  if (!Number.isFinite(contextLimitTokens)) return 0;
  return Math.max(
    0,
    Math.floor(contextLimitTokens) -
      COMPACTION_MAX_COMPLETION_TOKENS -
      COMPACTION_INPUT_SAFETY_TOKENS,
  );
}

export function calibratedCompactionSinglePassInputBudget(
  contextLimitTokens: number,
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  const nominalInputBudget = compactionSinglePassInputBudget(contextLimitTokens);
  const calibration = requestTokenCalibration(provider, model);
  return calibration && calibration.ratio > 1
    ? Math.floor(nominalInputBudget / calibration.ratio)
    : nominalInputBudget;
}

export const COMPACTION_MAP_MAX_COMPLETION_TOKENS = 16_384;

export const COMPACTION_CHUNK_CHAR_BUDGET = 64_000;

export const MAX_COMPACTION_CHUNKS = 8;

export function chunkTranscriptForCompaction(
  transcript: string,
  chunkChars = COMPACTION_CHUNK_CHAR_BUDGET,
  maxChunks = MAX_COMPACTION_CHUNKS,
): string[] {
  const text = transcript.trim();
  if (!text) return [];
  const size = Math.max(chunkChars, Math.ceil(text.length / maxChunks));
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (chunks.length === maxChunks - 1) {
      chunks.push(text.slice(index));
      break;
    }
    const hardEnd = Math.min(text.length, index + size);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const boundary = text.lastIndexOf("\n\n", hardEnd);
      if (boundary > index + Math.floor(size * 0.5)) end = boundary;
    }
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

export function trimTranscriptForCompaction(
  transcript: string,
  budget = COMPACTION_TRANSCRIPT_CHAR_BUDGET,
): string {
  if (transcript.length <= budget) return transcript;
  const head = Math.floor(budget * 0.35);
  const tail = budget - head - 80;
  return (
    transcript.slice(0, head) +
    "\n\n[... middle of session omitted for length ...]\n\n" +
    transcript.slice(-tail)
  );
}



export function normalizeCompactionSummary(summary: string): string {
  const seenBullets = new Set<string>();
  const parents: { indent: number; text: string }[] = [];
  const output: string[] = [];
  for (const line of stripReasoningMarkers(summary)
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      seenBullets.clear();
      parents.length = 0;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (bullet) {
      const indent = line.length - line.trimStart().length;
      while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
      const text = bullet[1]!.trim();
      const key = JSON.stringify([parents.map((parent) => parent.text), indent, text]);
      parents.push({ indent, text });
      if (seenBullets.has(key)) continue;
      seenBullets.add(key);
    }
    if (!trimmed && output[output.length - 1]?.trim() === "") continue;
    output.push(line.replace(/[ \t]+$/g, ""));
  }
  return output.join("\n").trim();
}

export function looksLikeIncompleteCompactionSummary(summary: string): boolean {
  const text = summary.trim();
  if (!text) return true;
  if ((text.match(/```/g)?.length ?? 0) % 2 !== 0) return true;
  const last = text.split("\n").at(-1)?.trim() ?? "";
  if (/^#{1,6}\s+\S/.test(last)) return true;
  if (/[,;:(\[{=+\-–—]$/.test(last)) return true;
  return /\b(?:and|or|the|a|an|to|with|without|has|have|had|is|are|was|were|from|for|of|in|on|at|by|as|that|which|whose|because|so)$/i.test(last);
}

export function isCompactionCompletionTruncated(
  response: {
    finishReason?: string | undefined;
    usage?: { completionTokens?: number | undefined } | undefined;
  },
  maxTokens: number,
): boolean {
  const finish = response.finishReason?.toLowerCase();
  if (finish === "length") return true;
  if (finish === "stop") return false;
  const used = response.usage?.completionTokens;
  return typeof used === "number" && used >= Math.max(1, maxTokens - 32);
}

export function looksLikeTranscriptReplay(summary: string): boolean {
  const hardMarkers = [
    /sha256_12\s*=/i,
    /Do NOT re-read this file/i,
    /\(\s*exit\s*=\s*-?\d+\s*,\s*ok\s*=\s*(?:true|false)\s*\)/i,
    /<tool_calls?(?::[^>]+)?>|<arg_key>|<arg_value>|<\/tool_call/i,
    /[\ue000\ue001]/,
    /<\|tool_(?:calls_section|call|call_argument)_(?:begin|end)\|>/i,
    /<[|｜]+tool[_▁](?:calls?[_▁](?:begin|end)|sep)[|｜]+>/i,
    /<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b/i,
    /<[|｜]+(?:open|close|sep)[|｜]+>/i,
    /\bbytes\s*=\s*\d+\s+lines\s*=\s*\d+/i,
  ];
  if (hardMarkers.some((re) => re.test(summary))) return true;

  const softMarkers = [
    /^\s*TOOL:\s*Tool\b/im,
    /\[tools:\s/i,
    /\bLet me continue\b/i,
    /\bTask t\d+:/,
  ];
  return softMarkers.filter((re) => re.test(summary)).length >= 2;
}
