import type { ChatMessage } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { stripThinking } from "../ui/thinking.js";
import {
  hasReasoningMarker,
  stripReasoningMarkers,
} from "../llm/reasoning-marker.js";
import {
  expandKeepStartForToolPairs,
  hasOrphanToolMessages,
} from "./tool-history.js";
import {
  buildCompactionChunkPrompt,
  buildCompactionReducePrompt,
  buildCompactionUserPrompt,
  buildDirectCompactionPrompt,
  chunkTranscriptForCompaction,
  COMPACTION_CHUNK_CHAR_BUDGET,
  looksLikeIncompleteCompactionSummary,
  looksLikeTranscriptReplay,
  normalizeCompactionSummary,
} from "./compaction-summary.js";
import {
  DURABLE_ENVELOPE_PREFIX,
  isDurableEnvelopeContent,
} from "./durable-envelope.js";
import {
  isResponderResultLedgerMessage,
  RESPONDER_RESULT_LEDGER_PREFIX,
} from "./responder-context.js";
import { slimToolArgs } from "./message-slim.js";
import {
  estimateImageTokens,
  estimateMessagesTokens,
  estimateTextTokens as estimateTokens,
} from "./request-accounting.js";

export { estimateImageTokens, estimateMessagesTokens, estimateTokens };

/**
 * Token estimation lives in `request-accounting.ts` — the one serialized-
 * request accounting service. The exports above keep this module's historic
 * public surface; nothing here owns a chars-per-token ratio anymore.
 */

/**
 * Agent-loop auto-compact threshold (estimated tokens). Shared with `/context`
 * so the reported % of budget matches when auto-compaction fires.
 *
 * 180k: provider/model-neutral default. A session-specific model window can
 * opt into a 70%-of-window trigger.
 */
export const AUTO_COMPACT_TOKEN_BUDGET = 180_000;

/**
 * Soft post-compact band we *prefer* (includes system prompt ~8k).
 * Achieved by dense memory + progressive soft-trim of oversized dumps only.
 * Never a reject gate, never drops messages/tool pairs to hit the number.
 */
export const POST_COMPACT_SOFT_GUIDANCE_TOKENS = 16_000;
/** Prefer landing at or under this; still accept if content needs more room. */
export const POST_COMPACT_SOFT_UPPER_BAND_TOKENS = 20_000;

type TailPreferMax = { tool: number; assistant: number; user: number };

/**
 * Progressive soft-trim tiers for the kept tail. Start generous; only step
 * tighter if estimate is still above the soft upper band. Never blanks a
 * message or removes tool pairs.
 */
const TAIL_SOFT_TIERS: readonly TailPreferMax[] = [
  { tool: 6_000, assistant: 8_000, user: 8_000 },
  { tool: 4_000, assistant: 5_000, user: 6_000 },
  { tool: 2_500, assistant: 3_500, user: 4_000 },
];

/** Auto-compact: reject empty/near-empty memory after large history (amnesia). */
export const AUTO_COMPACT_STUB_MIN_CHARS = 120;
export const AUTO_COMPACT_STUB_BEFORE_TOKENS = 20_000;

export interface CompactOptions {
  /** Soft budget (tokens). When estimated tokens exceed this, compact. */
  budgetTokens?: number | undefined;
  /** Keep this many trailing messages (system + user/assistant pairs). */
  keepRecent?: number | undefined;
  singlePassInputBudgetTokens?: number | undefined;
  /**
   * Bias summarizer prompt (e.g. plan-implement preserves recon evidence).
   * Does not change accept/reject heuristics.
   */
  purpose?: "default" | "plan-implement" | undefined;
  // Deterministic canonical state (files, evidence, criteria, plan, responder
  // ledger) built by the caller from durable stores. Fed to the summarizer as
  // authoritative state and re-injected verbatim after compaction.
  durableEnvelope?: string | undefined;
  /**
   * At most one summarizer dispatch: forbids automatic map/reduce. When the
   * full settled range does not fit one pass, summarize the oldest complete
   * message-aligned slice (emergency_prefix_slice) and retain the untouched
   * middle/recent tail.
   */
  singleAdmission?: boolean | undefined;
  /**
   * Choose the direct single pass whenever source messages exist, skipping the
   * estimate gate. Callers set this only after pre-flighting that the exact
   * assembled request fits (e.g. a cache-preserving snapshot replay planned
   * with `planCompactionReplay`) — the raw estimate gate is deliberately
   * conservative and would otherwise reject requests that fit fine.
   */
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

const DEFAULT_BUDGET_TOKENS = 32_000;
/** Default keepRecent for mechanical compact; LLM auto path uses 2 via runner. */
const DEFAULT_KEEP_RECENT = 2;

/**
 * Content prefixes that mark a `role:"system"` message as compacted session
 * memory (vs. the main system prompt or transient injected guidance). Exported
 * so history-persistence can KEEP this memory when it drops other system
 * messages — otherwise a resumed session that compacted mid-run would lose all
 * summarized context.
 */
export const COMPACTION_MEMORY_PREFIX =
  "Session memory from compacted earlier turns:";
/**
 * Plan-mode research handoff memory (pre-implement compact). Distinct so the
 * agent does not treat plan-mode gather-only history as permanent gates.
 * Explicitly ties this context to the plan/tasks the implementer is seeing.
 */
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

/** Prefix used when writing a compacted memory system message. */
export function compactionMemoryPrefixForPurpose(
  purpose?: "default" | "plan-implement" | undefined,
): string {
  return purpose === "plan-implement"
    ? PLAN_IMPLEMENT_MEMORY_PREFIX
    : COMPACTION_MEMORY_PREFIX;
}

/**
 * Replace older messages with a single condensed "memory" message while
 * preserving the system prompt and the most recent N messages.
 *
 * We do not call the LLM here — that's a future enhancement. The current
 * compaction is mechanical: keep the system prompt; replace the prefix of
 * older turns with a bullet list of the assistant's last lines and the
 * tool calls that produced output. This is conservative and reversible
 * (the artifact files still hold the raw outputs).
 */
function assistantVisibleOnly(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  if (
    !hasReasoningMarker(message.content) &&
    !/^\s*<think(?:ing)?\b/i.test(message.content)
  ) {
    return message;
  }
  const visible = stripThinking(message.content).visible;
  return {
    ...message,
    content: visible || stripReasoningMarkers(message.content),
  };
}

export function compactMessages(
  messages: ChatMessage[],
  options: CompactOptions = {},
): ChatMessage[] {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  if (messages.length <= keepRecent + 1) return messages;
  if (estimateMessagesTokens(messages) <= budget) return messages;

  // Keep the real system prompt, but never pin prior compaction memory as
  // the head: re-compaction must summarize/replace that stale memory.
  const head: ChatMessage[] = [];
  let start = 0;
  if (
    messages[0]?.role === "system" &&
    !isCompactionMemoryMessage(messages[0])
  ) {
    head.push(messages[0]);
    start = 1;
  }

  let tailStart = Math.max(start, messages.length - keepRecent);
  tailStart = expandKeepStartForToolPairs(messages, tailStart);
  const tail = messages.slice(tailStart).map(assistantVisibleOnly);
  const middle = messages.slice(start, tailStart);
  if (middle.length === 0) return messages;

  const bullets: string[] = [];
  for (const raw of middle) {
    const msg = assistantVisibleOnly(raw);
    if (msg.role === "user") {
      bullets.push(`- user asked: ${oneLine(msg.content, 200)}`);
    } else if (msg.role === "assistant") {
      const line = oneLine(msg.content, 200);
      if (line) bullets.push(`- assistant: ${line}`);
      if (msg.toolCalls?.length) {
        bullets.push(
          `- assistant tools: ${msg.toolCalls.map((t) => t.name).join(", ")}`,
        );
      }
    } else if (msg.role === "tool") {
      bullets.push(`- tool result: ${oneLine(msg.content, 200)}`);
    }
  }

  const memo: ChatMessage = {
    role: "system",
    content:
      `${MECHANICAL_MEMORY_PREFIX} to fit the context budget. Full artifacts (when produced) are saved on disk and can be expanded with /output.\n\n` +
      bullets.join("\n"),
  };

  let ledger: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isResponderResultLedgerMessage(messages[index]!)) {
      ledger = messages[index];
      break;
    }
  }
  const preservedLedger =
    ledger && !head.includes(ledger) && !tail.includes(ledger) ? [ledger] : [];
  return [...head, memo, ...preservedLedger, ...tail];
}

export interface CompactionSummaryStage {
  readonly phase: "single" | "map" | "reduce";
  readonly index?: number | undefined;
  readonly total?: number | undefined;
  readonly sourceMessages?: readonly ChatMessage[] | undefined;
}

/**
 * Compact older turns into a model-written memory while retaining recent
 * messages verbatim. The model summary is the ONLY compaction path: if the
 * model fails to produce a summary we DO NOT fall back to a mechanical dump
 * of the transcript (that historically produced an enormous, low-quality
 * "memory" of tens of thousands of lines). Instead we throw, so the caller
 * can report the failure and the original messages stay untouched.
 */
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

  // If forced and the older slice would be empty, try keeping fewer recent
  // messages (minimum 1) so we have something to compact (e.g. the first user prompt).
  if (older.length === 0 && isForced && messages.length >= start + 2) {
    keepRecent = 1;
    tailStart = messages.length - 1;
    tailStart = expandKeepStartForToolPairs(messages, tailStart);
    older = messages.slice(start, tailStart);
  }

  if (older.length === 0 && !sessionTranscript?.trim()) {
    // Genuinely nothing to compact yet — return a no-op result.
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
    isDurableEnvelopeContent(content) ||
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    isResponderResultLedgerMessage({ role: "system", content }) ||
    content.includes("\nACTIVE PLAN") ||
    content.includes("SESSION STATE / WORKING MEMORY");

  // Stale ACTIVE PLAN / SESSION STATE / SCOPE snapshots are re-injected fresh
  // after compaction and their current form is captured in durableState below.
  // Feeding old copies into the summarizer only bloats input and invites the
  // model to restate the plan — drop them from the transcript.
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
    .filter((m) => m.role === "system" && isDurableSystem(m.content))
    .map((m) => {
      // Large system prompts: extract only durable subsections when present.
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

  // Prefer ~16–20k: start with a generous lean tail, then progressively
  // soft-trim oversized dumps only while still over the soft upper band.
  // Never drop messages or tool pairs. If still high after last tier, accept.
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

  // Structural safety only — never reject because afterTokens > soft band.
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

/**
 * Whether an auto-compact result is safe to apply.
 * Only structural / quality gates — never "afterTokens must be under N".
 */
export function shouldApplyAutoCompact(input: {
  summarized: boolean;
  summaryBody: string;
  beforeTokens: number;
  afterTokens: number;
  afterMessages: readonly ChatMessage[];
}): boolean {
  if (!input.summarized) return false;
  // Must actually shrink (otherwise pointless and can thrash).
  if (input.afterTokens >= input.beforeTokens) return false;
  if (hasOrphanToolMessages([...input.afterMessages])) return false;
  const body = input.summaryBody.trim();
  if (!body) return false;
  // Amnesia stub only — not a target-size check.
  if (
    input.beforeTokens >= AUTO_COMPACT_STUB_BEFORE_TOKENS &&
    body.length < AUTO_COMPACT_STUB_MIN_CHARS
  ) {
    return false;
  }
  return true;
}

function isStaleDurableSystem(content: string): boolean {
  return (
    isDurableEnvelopeContent(content) ||
    content.startsWith("ACTIVE PLAN") ||
    content.startsWith("SESSION STATE") ||
    content.startsWith("ENGAGEMENT SCOPE") ||
    content.startsWith("TASK ANALYSIS") ||
    content.includes("SESSION STATE / WORKING MEMORY")
  );
}

/** Soft head+tail prefer — only when a single message is huge waste. */
function preferTrimContent(text: string, preferMax: number): string {
  if (text.length <= preferMax) return text;
  const half = Math.floor((preferMax - 48) / 2);
  if (half < 120) return text; // don't mangle medium messages
  return `${text.slice(0, half)}\n…(trimmed oversized dump in compact tail; full may be on disk)…\n${text.slice(-half)}`;
}

function leanTailMessages(
  tail: ChatMessage[],
  preferMax: { tool: number; assistant: number; user: number },
): ChatMessage[] {
  return tail
    .filter((msg) => {
      // Fresh plan/session are re-injected after compact — drop stale copies.
      if (msg.role === "system" && isStaleDurableSystem(msg.content)) {
        return false;
      }
      // Drop prior compaction memory from the tail (new memory is the prefix).
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

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
