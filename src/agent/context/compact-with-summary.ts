import { AGENT_INSTRUCTIONS_PREFIX } from "../../instructions/load.js";
import { redactSecrets } from "../../llm/provider.js";
import { hasReasoningMarker } from "../../llm/reasoning-marker.js";
import { ACTIVE_SKILLS_PREFIX } from "../../skills/catalog.js";
import type { ChatMessage } from "../../types.js";
import { stripThinking } from "../../ui/thinking.js";
import { buildCompactionChunkPrompt, buildCompactionReducePrompt, buildCompactionUserPrompt, buildDirectCompactionPrompt, chunkTranscriptForCompaction, COMPACTION_CHUNK_CHAR_BUDGET, looksLikeIncompleteCompactionSummary, looksLikeTranscriptReplay, normalizeCompactionSummary } from "../compaction-summary.js";
import { DURABLE_ENVELOPE_PREFIX, isDurableEnvelopeContent } from "../durable-envelope.js";
import { slimToolArgs } from "../message-slim.js";
import { estimateMessagesTokens, estimateTextTokens as estimateTokens } from "../request-accounting.js";
import { isResponderResultLedgerMessage, RESPONDER_RESULT_LEDGER_PREFIX } from "../responder-context.js";
import { expandKeepStartForToolPairs, hasOrphanToolMessages } from "../tool-history.js";

export const POST_COMPACT_SOFT_UPPER_BAND_TOKENS = 20_000;

type TailPreferMax = { tool: number; assistant: number; user: number };

const TAIL_SOFT_TIERS: readonly TailPreferMax[] = [
  { tool: 6_000, assistant: 8_000, user: 8_000 },
  { tool: 4_000, assistant: 5_000, user: 6_000 },
  { tool: 2_500, assistant: 3_500, user: 4_000 },
];

export interface CompactOptions {
  budgetTokens?: number | undefined;
  keepRecent?: number | undefined;
  singlePassInputBudgetTokens?: number | undefined;
  purpose?: "default" | "plan-implement" | undefined;
  durableEnvelope?: string | undefined;
  singleAdmission?: boolean | undefined;
  forceDirectSinglePass?: boolean | undefined;
}

export type CompactionStrategy =
  | "direct"
  | "single"
  | "emergency_prefix_slice"
  | "map_reduce";

export interface CompactResult {
  messages: ChatMessage[];
  before: number;
  after: number;
  beforeTokens: number;
  afterTokens: number;
  summarized: boolean;
  strategy?: CompactionStrategy | undefined;
}

export const DEFAULT_KEEP_RECENT = 2;

export const COMPACTION_MEMORY_PREFIX =
  "Session memory from compacted earlier turns:";

const LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX =
  "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement — gather-only phase is over; execute approved tasks):";

export const PLAN_IMPLEMENT_MEMORY_PREFIX =
  "PLAN MODE HANDOFF: research memory for the accepted implementation phase. Gather-only/await-approval gates are historical; ACTIVE PLAN and SESSION STATE are authoritative:";

export const MECHANICAL_MEMORY_PREFIX =
  "Earlier turns in this session, summarized";

export function isCompactionMemoryMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    (message.content.startsWith(COMPACTION_MEMORY_PREFIX) ||
      message.content.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX) ||
      message.content.startsWith(LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX) ||
      message.content.startsWith(MECHANICAL_MEMORY_PREFIX))
  );
}

export function compactionMemoryPrefixForPurpose(
  purpose?: "default" | "plan-implement" | undefined,
): string {
  return purpose === "plan-implement"
    ? PLAN_IMPLEMENT_MEMORY_PREFIX
    : COMPACTION_MEMORY_PREFIX;
}

export interface CompactionSummaryStage {
  readonly phase: "single" | "map" | "reduce";
  readonly index?: number | undefined;
  readonly total?: number | undefined;
  readonly sourceMessages?: readonly ChatMessage[] | undefined;
}

export async function compactMessagesWithSummary(
  messages: ChatMessage[],
  summarize: (
    prompt: string,
    stage?: CompactionSummaryStage,
  ) => Promise<string>,
  options: CompactOptions = {},
  sessionTranscript?: string | undefined,
): Promise<CompactResult> {
  const before = messages.length;
  const beforeTokens = estimateMessagesTokens(messages);
  const isForced = options.budgetTokens === 0;

  let keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const firstMessage = messages[0];
  const preserveSystemHead =
    firstMessage?.role === "system" &&
    !isCompactionMemoryMessage(firstMessage);
  const start = preserveSystemHead ? 1 : 0;
  let tailStart = Math.max(start, messages.length - keepRecent);
  tailStart = expandKeepStartForToolPairs(messages, tailStart);
  let older = messages.slice(start, tailStart);

  if (older.length === 0 && isForced && messages.length >= start + 2) {
    keepRecent = 1;
    tailStart = messages.length - 1;
    tailStart = expandKeepStartForToolPairs(messages, tailStart);
    older = messages.slice(start, tailStart);
  }

  if (older.length === 0 && !sessionTranscript?.trim()) {
    return {
      messages: [...messages],
      before,
      after: before,
      beforeTokens,
      afterTokens: beforeTokens,
      summarized: false,
    };
  }

  const isDurableSystem = (content: string): boolean =>
    isReinjectedSystem(content) ||
    isDurableEnvelopeContent(content) ||
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    isResponderResultLedgerMessage({ role: "system", content }) ||
    content.includes("\nACTIVE PLAN") ||
    content.includes("SESSION STATE / WORKING MEMORY");

  const visual = sessionTranscript?.trim()
    ? redactSecrets(sessionTranscript.trim())
    : "";

  const historyRecords = (visual ? older : messages.slice(start))
    .filter(
      (message) => !(message.role === "system" && isDurableSystem(message.content)),
    )
    .map((message) => {
      let content = redactSecrets(message.content);
      if (message.role === "assistant") {
        content = stripThinking(content).visible;
      }
      const source = content.trim();
      if (message.toolCalls?.length) {
        content +=
          "\n[tools: " +
          message.toolCalls.map((t) => t.name).join(", ") +
          "]";
      }
      return { source, rendered: `${message.role.toUpperCase()}: ${content}` };
    });
  const uncoveredHistory = visual
    ? historyRecords.filter(
        (record) => !record.source || !visual.includes(record.source),
      )
    : historyRecords;
  const messageTranscript = uncoveredHistory
    .map((record) => record.rendered)
    .join("\n\n");
  const visualCoversOlderHistory =
    Boolean(visual) && uncoveredHistory.length === 0;

  const durableBits = messages
    .filter(
      (m) =>
        m.role === "system" &&
        isDurableSystem(m.content) &&
        !isReinjectedSystem(m.content),
    )
    .map((m) => {
      if (m.content.length > 4_000) {
        const chunks: string[] = [];
        for (const marker of [
          DURABLE_ENVELOPE_PREFIX,
          "ACTIVE PLAN",
          "SESSION STATE / WORKING MEMORY",
          "ENGAGEMENT SCOPE",
          "TASK ANALYSIS",
          RESPONDER_RESULT_LEDGER_PREFIX,
        ]) {
          const idx = m.content.indexOf(marker);
          if (idx >= 0) chunks.push(m.content.slice(idx, idx + 2_500));
        }
        return chunks.join("\n\n") || m.content.slice(0, 2_000);
      }
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  const durableState = [options.durableEnvelope?.trim(), durableBits]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  const combinedTranscript = [
    visual ? `VISUAL TRANSCRIPT:\n\n${visual}` : "",
    messageTranscript && !visualCoversOlderHistory
      ? `OLDER MODEL TURNS:\n\n${messageTranscript}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const directPrompt = buildDirectCompactionPrompt({
    ...(durableState ? { durableState } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
  });
  const directSourceMessages = visual ? undefined : messages;
  const singlePassInputBudget = Math.max(
    0,
    options.singlePassInputBudgetTokens ?? 0,
  );
  const directInputTokens = directSourceMessages
    ? estimateMessagesTokens([
        ...directSourceMessages,
        { role: "user", content: directPrompt },
      ])
    : Number.POSITIVE_INFINITY;
  const useDirectSinglePass =
    Boolean(directSourceMessages?.length) &&
    (options.forceDirectSinglePass === true ||
      (singlePassInputBudget > 0 &&
        directInputTokens <= singlePassInputBudget));
  const serializedPromptTokens = estimateTokens(
    buildCompactionUserPrompt({
      messageTranscript: "",
      ...(durableState ? { durableState } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
    }),
  );
  const dynamicChunkChars =
    singlePassInputBudget > serializedPromptTokens
      ? Math.max(
          COMPACTION_CHUNK_CHAR_BUDGET,
          Math.floor(
            (singlePassInputBudget - serializedPromptTokens) * 3.3,
          ),
        )
      : COMPACTION_CHUNK_CHAR_BUDGET;
  const chunks = chunkTranscriptForCompaction(
    combinedTranscript,
    dynamicChunkChars,
  );

  const summarizeUsable = async (
    prompt: string,
    stage: CompactionSummaryStage,
  ): Promise<string> => {
    const first = await summarize(prompt, stage);
    const visible = normalizeCompactionSummary(
      stripThinking(first ?? "").visible,
    );
    if (!visible) {
      throw new Error("compaction failed: model returned an empty summary");
    }
    if (looksLikeTranscriptReplay(visible)) {
      throw new Error(
        "compaction failed: model replayed the transcript instead of summarizing — original context retained",
      );
    }
    if (looksLikeIncompleteCompactionSummary(visible)) {
      throw new Error(
        "compaction failed: model returned an incomplete summary — original context retained",
      );
    }
    return visible;
  };

  let modelSummary: string;
  let strategy: CompactionStrategy;
  let retainedMiddle: ChatMessage[] = [];
  if (useDirectSinglePass && directSourceMessages) {
    strategy = "direct";
    modelSummary = await summarizeUsable(directPrompt, {
      phase: "single",
      sourceMessages: directSourceMessages,
    });
  } else if (chunks.length <= 1) {
    strategy = "single";
    modelSummary = await summarizeUsable(
      buildCompactionUserPrompt({
        visualTranscript: visual || undefined,
        messageTranscript: visualCoversOlderHistory ? "" : messageTranscript,
        durableState: durableState || undefined,
        purpose: options.purpose,
      }),
      { phase: "single" },
    );
  } else if (options.singleAdmission) {
    if (visual) {
      throw new Error(
        "compaction failed: single-admission compaction cannot slice a visual transcript — run /compact explicitly",
      );
    }
    let sliceEnd = 0;
    let sliceChars = 0;
    for (let index = 0; index < older.length; index += 1) {
      const message = older[index]!;
      if (message.role === "system" && isDurableSystem(message.content)) {
        continue;
      }
      let content = redactSecrets(message.content);
      if (message.role === "assistant") {
        content = stripThinking(content).visible;
      }
      const rendered = `${message.role.toUpperCase()}: ${content}${
        message.toolCalls?.length
          ? `\n[tools: ${message.toolCalls.map((t) => t.name).join(", ")}]`
          : ""
      }`;
      if (sliceChars > 0 && sliceChars + rendered.length > dynamicChunkChars) {
        break;
      }
      sliceChars += rendered.length + 2;
      sliceEnd = index + 1;
    }
    if (sliceEnd === 0) sliceEnd = 1;
    while (
      sliceEnd < older.length &&
      older[sliceEnd - 1]?.role === "assistant" &&
      older[sliceEnd - 1]!.toolCalls?.length &&
      older[sliceEnd]?.role === "tool"
    ) {
      sliceEnd += 1;
    }
    strategy = "emergency_prefix_slice";
    retainedMiddle = older.slice(sliceEnd);
    const sliceTranscript = older
      .slice(0, sliceEnd)
      .filter(
        (message) =>
          !(message.role === "system" && isDurableSystem(message.content)),
      )
      .map((message) => {
        let content = redactSecrets(message.content);
        if (message.role === "assistant") {
          content = stripThinking(content).visible;
        }
        return `${message.role.toUpperCase()}: ${content}${
          message.toolCalls?.length
            ? `\n[tools: ${message.toolCalls.map((t) => t.name).join(", ")}]`
            : ""
        }`;
      })
      .join("\n\n");
    modelSummary = await summarizeUsable(
      buildCompactionUserPrompt({
        messageTranscript: sliceTranscript,
        durableState: durableState || undefined,
        purpose: options.purpose,
      }),
      { phase: "single" },
    );
  } else {
    strategy = "map_reduce";
    const mapped = await Promise.all(
      chunks.map(async (chunk, index) => {
        const partial = await summarizeUsable(
          buildCompactionChunkPrompt({
            chunk,
            index,
            total: chunks.length,
            purpose: options.purpose,
          }),
          { phase: "map", index, total: chunks.length },
        );
        return stripThinking(partial ?? "").visible.trim();
      }),
    );
    const partials = mapped.filter((cleaned) => cleaned.length > 0);
    if (partials.length === 0) {
      throw new Error(
        "compaction failed: no region summary was produced for a long session",
      );
    }
    modelSummary = await summarizeUsable(
      buildCompactionReducePrompt({
        partials,
        ...(durableState ? { durableState } : {}),
        ...(options.purpose ? { purpose: options.purpose } : {}),
      }),
      { phase: "reduce", total: chunks.length },
    );
  }

  const rawSummary = redactSecrets(modelSummary.trim());
  const summary = normalizeCompactionSummary(
    stripThinking(rawSummary).visible,
  );
  if (!summary) {
    throw new Error("compaction failed: model returned an empty summary");
  }
  if (looksLikeTranscriptReplay(summary)) {
    throw new Error(
      "compaction failed: model replayed the transcript instead of summarizing — retry /compact or switch model",
    );
  }
  if (looksLikeIncompleteCompactionSummary(summary)) {
    throw new Error(
      "compaction failed: model returned an incomplete summary — retry /compact or switch model",
    );
  }

  const head = preserveSystemHead ? [messages[0]!] : [];
  let rawTail = [...retainedMiddle, ...messages.slice(tailStart)];
  if (options.durableEnvelope?.trim()) {
    rawTail = rawTail.filter(
      (message) =>
        !(message.role === "system" && isDurableEnvelopeContent(message.content)),
    );
  }
  let responderLedger: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isResponderResultLedgerMessage(messages[index]!)) {
      responderLedger = messages[index];
      break;
    }
  }
  const compactHead =
    responderLedger &&
    !head.includes(responderLedger) &&
    !rawTail.includes(responderLedger)
      ? [...head, responderLedger]
      : head;
  const memoryPrefix = compactionMemoryPrefixForPurpose(options.purpose);
  const memoryMsg: ChatMessage = {
    role: "system",
    content: `${memoryPrefix}\n\n${summary}`,
  };
  const envelopeMsg: ChatMessage | undefined = options.durableEnvelope?.trim()
    ? { role: "system", content: options.durableEnvelope.trim() }
    : undefined;

  let compacted = buildLeanCompact(
    compactHead,
    memoryMsg,
    rawTail,
    TAIL_SOFT_TIERS[0]!,
    envelopeMsg,
  );
  for (let i = 1; i < TAIL_SOFT_TIERS.length; i += 1) {
    if (estimateMessagesTokens(compacted) <= POST_COMPACT_SOFT_UPPER_BAND_TOKENS) {
      break;
    }
    compacted = buildLeanCompact(
      compactHead,
      memoryMsg,
      rawTail,
      TAIL_SOFT_TIERS[i]!,
      envelopeMsg,
    );
  }

  if (hasOrphanToolMessages(compacted)) {
    throw new Error(
      "compaction failed: would produce orphan tool messages — keeping full history",
    );
  }

  const afterTokens = estimateMessagesTokens(compacted);
  return {
    messages: compacted,
    before,
    after: compacted.length,
    beforeTokens,
    afterTokens,
    summarized: true,
    strategy,
  };
}

function buildLeanCompact(
  head: ChatMessage[],
  memoryMsg: ChatMessage,
  rawTail: ChatMessage[],
  preferMax: TailPreferMax,
  envelopeMsg?: ChatMessage | undefined,
): ChatMessage[] {
  return [
    ...head,
    memoryMsg,
    ...(envelopeMsg ? [envelopeMsg] : []),
    ...leanTailMessages(rawTail, preferMax),
  ];
}

function isReinjectedSystem(content: string): boolean {
  return (
    content.startsWith(AGENT_INSTRUCTIONS_PREFIX) ||
    content.startsWith(ACTIVE_SKILLS_PREFIX)
  );
}

function isStaleDurableSystem(content: string): boolean {
  return (
    isReinjectedSystem(content) ||
    isDurableEnvelopeContent(content) ||
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    content.includes("SESSION STATE / WORKING MEMORY")
  );
}

function preferTrimContent(text: string, preferMax: number): string {
  if (text.length <= preferMax) return text;
  const half = Math.floor((preferMax - 48) / 2);
  if (half < 120) return text;
  return `${text.slice(0, half)}\n…(trimmed oversized dump in compact tail; full may be on disk)…\n${text.slice(-half)}`;
}

function leanTailMessages(
  tail: ChatMessage[],
  preferMax: { tool: number; assistant: number; user: number },
): ChatMessage[] {
  return tail
    .filter((msg) => {
      if (msg.role === "system" && isStaleDurableSystem(msg.content)) {
        return false;
      }
      if (isCompactionMemoryMessage(msg)) return false;
      return true;
    })
    .map((msg) => {
      if (msg.role === "tool") {
        return { ...msg, content: preferTrimContent(msg.content, preferMax.tool) };
      }
      if (msg.role === "assistant") {
        const visible =
          /<think/i.test(msg.content) || hasReasoningMarker(msg.content)
            ? stripThinking(msg.content).visible
            : msg.content;
        const slimCalls = msg.toolCalls?.map((tc) => ({
          ...tc,
          args: slimToolArgs(tc.args ?? {}),
        }));
        return {
          ...msg,
          content: preferTrimContent(visible, preferMax.assistant),
          ...(slimCalls ? { toolCalls: slimCalls } : {}),
        };
      }
      if (msg.role === "user") {
        return {
          ...msg,
          content: preferTrimContent(msg.content, preferMax.user),
        };
      }
      return msg;
    });
}
