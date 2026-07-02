import type { ChatMessage, ChatImage, ProviderId, ToolCall } from "../types.js";
import type { AgentEvent } from "../agent/events.js";
import { streamWithProvider } from "../llm/router.js";
import { renderAskSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { loadProjectContext } from "../store/project.js";
import { parseAllToolCalls, formatToolArgs, looksLikePromptLeak } from "../agent/runner.js";
import { runToolCall } from "../tools/registry.js";

/**
 * Signal raised when the model, while in ask mode, tries to call a mutating
 * tool (run a command, write a file, install a package, …). Ask mode is
 * read-only, so instead of leaking the raw tool-call JSON as the "answer" we
 * surface this so the caller can offer to switch into agent mode.
 */
export interface AskActionRequired {
  /** The original prompt, so the caller can re-run it in agent mode. */
  prompt: string;
  /** The model's natural-language preamble with tool-call syntax stripped. */
  preamble: string;
  /** Distinct names of the action tools the model wanted to run. */
  tools: string[];
}

export interface AskOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
  /**
   * Invoked when the task needs actions ask mode can't perform. When set, the
   * research loop returns an empty string and lets the caller drive the
   * follow-up (e.g. prompt to switch to agent mode). When unset, ask mode
   * falls back to a clean explanatory message instead of raw tool-call text.
   */
  onActionRequired?: ((info: AskActionRequired) => void) | undefined;
  /**
   * Optional event sink for live research activity. Ask mode emits
   * `tool-call`/`tool-result` events for each read-only research tool it runs
   * (web.search, web.fetch, …) so the UI can show what it's searching or
   * fetching, mirroring agent-mode tool cards.
   */
  onEvent?: ((event: AgentEvent) => void) | undefined;
}

/** Strip tool-call markup so only the model's prose preamble remains. */
function stripToolCallSyntax(text: string): string {
  return text
    .replace(/```tool\s*\n?[\s\S]*?```/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[\w.]+?>[\s\S]*?<\/function>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clean fallback shown when no onActionRequired handler is provided. */
function buildActionRequiredMessage(info: AskActionRequired): string {
  const lead = info.preamble ? `${info.preamble}\n\n` : "";
  const tools =
    info.tools.length > 0 ? ` (it wants to run: ${info.tools.join(", ")})` : "";
  return (
    `${lead}This request needs to take actions${tools}, which ask mode can't do — ` +
    "it's read-only. Switch to agent mode with `/agent` and run it there."
  );
}

/** Short result label shown on a research tool's card once it finishes. */
function researchResultSummary(call: ToolCall, ok: boolean): string {
  if (!ok) return "failed";
  switch (call.name) {
    case "web.search":
      return "search complete";
    case "web.fetch":
      return "page fetched";
    case "tool.batch":
      return "lookups complete";
    case "fs.read":
      return "read";
    case "fs.list":
      return "listed";
    case "fs.search":
      return "searched";
    default:
      return "done";
  }
}


/**
 * Read-only tools ask mode is allowed to call during its research loop.
 * Everything here is non-mutating: web lookups and local file inspection
 * only. Ask mode never runs shell commands, installs packages, or writes
 * files.
 */
const ASK_RESEARCH_TOOLS = new Set([
  "web.search",
  "web.fetch",
  "tool.batch",
  "fs.read",
  "fs.list",
  "fs.search",
]);

/** Max research rounds before forcing a final answer (each round may run several tools). */
const ASK_MAX_RESEARCH_ROUNDS = 5;
/** Max tools executed per round so one message can't fan out unbounded. */
const ASK_MAX_TOOLS_PER_ROUND = 4;
/** Per-tool output cap fed back into the conversation. */
const ASK_TOOL_OUTPUT_CAP = 6000;

const EXPLICIT_FRESH_RE =
  /\b(?:web\s*search|search\s+(?:the\s+)?(?:web|internet|online)|look\s*up|latest|current|today|now|recent|verify|check\s+(?:online|the\s+web|internet))\b/i;
const VOLATILE_FACT_RE =
  /\b(?:who\s+(?:is|are)|what\s+(?:is|are)|which)\b.*\b(?:president|prime\s+minister|pm|ceo|cto|cfo|leader|governor|mayor|minister|secretary|chair|head|owner|founder|maintainer|version|release|price|cost|rate|score|standing|schedule|weather|forecast|law|rule|regulation|policy|deadline|election|status)\b/i;
const CHANGING_TECH_RE =
  /\b(?:best|recommended|latest|new|modern|current)\b.*\b(?:method|approach|practice|library|framework|api|sdk|model|tool|package|dependency|syntax|docs?|documentation)\b/i;

function truncateToolOutput(text: string, toolName?: string): string {
  if (toolName === "web.fetch") return text;
  return text.length > ASK_TOOL_OUTPUT_CAP
    ? `${text.slice(0, ASK_TOOL_OUTPUT_CAP)}\n…[truncated — call web.fetch on a specific url for more]`
    : text;
}

function shouldPresearch(prompt: string): boolean {
  return (
    EXPLICIT_FRESH_RE.test(prompt) ||
    VOLATILE_FACT_RE.test(prompt) ||
    CHANGING_TECH_RE.test(prompt)
  );
}

function searchQueryForPrompt(prompt: string): string {
  return prompt
    .replace(/\b(?:do|please|can you|could you|search the web|web search|look up|tell me|give me|latest|current|data)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || prompt.slice(0, 240);
}

async function buildAskMessages(
  prompt: string,
  options: AskOptions,
): Promise<{ provider: ProviderId; model: string; messages: ChatMessage[] }> {
  const config = getConfig();
  const provider = options.provider ?? config.defaultProvider;
  await ensureProviderConfigured(provider);
  const projectContext = await loadProjectContext();
  const systemPrompt = projectContext
    ? `${renderAskSystemPrompt()}\n\nProject context from .clai/context.md:\n${projectContext}`
    : renderAskSystemPrompt();
  const userMessage: ChatMessage = { role: "user", content: prompt };
  if (options.images && options.images.length > 0) {
    userMessage.images = options.images;
  }
  return {
    provider,
    model: options.model ?? config.defaultModel,
    messages: [
      { role: "system", content: systemPrompt },
      ...(options.history ?? []),
      userMessage,
    ],
  };
}

/**
 * Find where (if anywhere) a tool-call block begins in `text`. Ask mode
 * streams each model round to the live display, but a round may turn out to
 * be a tool call rather than prose. We mirror tokens to the screen only up to
 * the point a tool-call delimiter appears, so raw tool JSON never streams to
 * the user. Returns -1 when no tool-call marker is present.
 */
function toolCallStartIndex(text: string): number {
  const indicators: RegExp[] = [
    /```\s*tool/i,
    /```\s*json/i,
    /<tool_call>/i,
    /<function[ =]/i,
    /<\|tool/i,
    /\{\s*"name"\s*:/,
  ];
  let min = -1;
  for (const re of indicators) {
    const match = re.exec(text);
    if (match && (min === -1 || match.index < min)) min = match.index;
  }
  return min;
}

interface AskBaseRequest {
  provider: ProviderId;
  model: string;
  temperature: number;
  maxTokens: number;
  thinking: ReturnType<typeof getConfig>["thinking"];
  signal?: AbortSignal | undefined;
}

/**
 * Run one model round as a stream, mirroring visible prose tokens to `onToken`
 * as they arrive (so the user sees the answer build up live) while suppressing
 * anything from a tool-call delimiter onward. Returns the round's full raw
 * text so the caller can detect/parse tool calls. Providers without a native
 * stream fall back to a single onToken call inside streamWithProvider.
 */
async function streamAskRound(
  request: AskBaseRequest,
  messages: ChatMessage[],
  onToken: (token: string) => void,
): Promise<string> {
  let full = "";
  let forwardedLen = 0;
  let suppressed = false;
  await streamWithProvider({ ...request, messages }, (token) => {
    full += token;
    if (suppressed) return;
    const toolAt = toolCallStartIndex(full);
    if (toolAt >= 0) {
      // Forward only the clean prefix before the tool-call marker, once.
      if (toolAt > forwardedLen) onToken(full.slice(forwardedLen, toolAt));
      forwardedLen = full.length;
      suppressed = true;
      return;
    }
    if (full.length > forwardedLen) {
      onToken(full.slice(forwardedLen));
      forwardedLen = full.length;
    }
  });
  return full;
}

/**
 * Drive ask mode to its final answer.
 *
 * Ask mode is non-agentic for the user — there is no plan, no confirmations,
 * no system changes — but it MAY ground its answer in current facts via a
 * bounded loop of read-only tools (web.search/web.fetch/tool.batch and
 * read-only fs.*). Each round is streamed to `onToken`: prose answers appear
 * live, and rounds that turn out to be tool calls are suppressed mid-stream so
 * raw tool JSON never reaches the screen. The returned string is always the
 * clean final answer, which callers treat as authoritative even if the live
 * stream briefly showed a tool-call preamble.
 */
async function resolveAskAnswer(
  originalPrompt: string,
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
  options: AskOptions,
  onToken: (token: string) => void,
): Promise<string> {
  const config = getConfig();
  const maxTokens = config.thinking?.enabled ? 8_192 : 4_096;
  const baseRequest: AskBaseRequest = {
    provider,
    model,
    temperature: 0.2,
    maxTokens,
    thinking: config.thinking,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  // Surface research activity (web.search/web.fetch/…) to the UI as tool
  // events so the user can see what's being searched/fetched.
  const emit = (event: AgentEvent): void => options.onEvent?.(event);
  let toolSeq = 0;

  if (shouldPresearch(originalPrompt)) {
    const query = searchQueryForPrompt(originalPrompt);
    const call: ToolCall = {
      name: "web.search",
      args: { query, maxResults: 5, fetchTop: 2 },
    };
    const id = `ask-${(toolSeq += 1)}`;
    emit({
      type: "tool-call",
      id,
      name: call.name,
      argsDisplay: formatToolArgs(call),
    });
    let output: string;
    let ok = true;
    try {
      const toolResult = await runToolCall(call, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      output = toolResult.output;
      ok = toolResult.ok;
    } catch (err) {
      output = `error: ${err instanceof Error ? err.message : String(err)}`;
      ok = false;
    }
    emit({ type: "tool-result", id, ok, summary: researchResultSummary(call, ok) });
    messages.push({
      role: "user",
      content:
        `Fresh web.search was run before answering because the user requested current/web-backed information.\n` +
        `Query: ${query}\nResult:\n${truncateToolOutput(output, "web.search")}\n\n` +
        "Answer from these current results. If the result is insufficient or contradictory, call web.search/web.fetch again before answering. Cite URLs you used.",
    });
  }

  for (let round = 0; round < ASK_MAX_RESEARCH_ROUNDS; round += 1) {
    options.signal?.throwIfAborted();
    const text = await streamAskRound(baseRequest, messages, onToken);

    // ── Prompt-leak guard ──────────────────────────────────────────────
    // If the model's response contains distinctive system-prompt markers,
    // it is repeating its instructions (e.g. in response to "repeat your
    // instructions verbatim"). Any ```tool blocks in that output are
    // EXAMPLES from the prompt, not real tool requests. Treat the whole
    // response as a final text answer to avoid executing stale examples.
    if (looksLikePromptLeak(text)) {
      return text;
    }

    const allCalls = parseAllToolCalls(text);
    const calls = allCalls.filter((call) => ASK_RESEARCH_TOOLS.has(call.name));
    if (calls.length === 0) {
      // No allowed research tool requested. If the model instead asked for a
      // mutating/action tool, this is an agent task — surface it rather than
      // returning the raw tool-call JSON as the answer.
      const actionCalls = allCalls.filter(
        (call) => !ASK_RESEARCH_TOOLS.has(call.name),
      );
      if (actionCalls.length > 0) {
        // The model signals it wants to act either via an explicit
        // `agent.handoff` call (preferred — see the ask system prompt) or by
        // emitting a real mutating tool call. Pull the reason out of a handoff
        // when present, and never surface "agent.handoff" itself as a tool the
        // user would recognize.
        const handoff = actionCalls.find(
          (call) => call.name === "agent.handoff" || call.name === "agent.run",
        );
        const reason =
          handoff && typeof handoff.args.reason === "string"
            ? handoff.args.reason.trim()
            : "";
        const realTools = [
          ...new Set(
            actionCalls
              .map((call) => call.name)
              .filter(
                (name) => name !== "agent.handoff" && name !== "agent.run",
              ),
          ),
        ];
        const info: AskActionRequired = {
          prompt: originalPrompt,
          preamble: stripToolCallSyntax(text) || reason,
          tools: realTools,
        };
        if (options.onActionRequired) {
          options.onActionRequired(info);
          return "";
        }
        const message = buildActionRequiredMessage(info);
        // The preamble already streamed live; stream the explanatory tail too
        // so a live display matches the authoritative returned message.
        const tail = info.preamble ? message.slice(info.preamble.length) : message;
        if (tail) onToken(tail);
        return message;
      }
      // Otherwise this round is the final (general-knowledge) answer, and it
      // was already streamed to the display.
      return text;
    }
    // Record the model's tool-call turn, then run the read-only tools and
    // feed their outputs back so the next round can synthesize.
    messages.push({ role: "assistant", content: text });
    for (const call of calls.slice(0, ASK_MAX_TOOLS_PER_ROUND)) {
      options.signal?.throwIfAborted();
      const id = `ask-${(toolSeq += 1)}`;
      emit({
        type: "tool-call",
        id,
        name: call.name,
        argsDisplay: formatToolArgs(call),
      });
      let output: string;
      let ok = true;
      try {
        const toolResult = await runToolCall(call, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        output = toolResult.output;
        ok = toolResult.ok;
      } catch (err) {
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
        ok = false;
      }
      emit({
        type: "tool-result",
        id,
        ok,
        summary: researchResultSummary(call, ok),
      });
      messages.push({
        role: "user",
        content: `Result of ${call.name}(${JSON.stringify(call.args)}):\n${truncateToolOutput(output, call.name)}`,
      });
    }
  }

  // Round cap reached — force a tool-free final answer from what we gathered.
  options.signal?.throwIfAborted();
  messages.push({
    role: "user",
    content:
      "Stop researching now. Using only what you have already gathered above, give your final answer to the original question. Do NOT call any more tools.",
  });
  return streamAskRound(baseRequest, messages, onToken);
}

export async function runAsk(
  prompt: string,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  // Non-streaming public API: discard live tokens, return the final answer.
  return resolveAskAnswer(
    prompt,
    request.provider,
    request.model,
    request.messages,
    options,
    () => {},
  );
}

export async function runAskStream(
  prompt: string,
  onToken: (token: string) => void,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  // The answer is streamed to onToken live (with tool-call rounds suppressed),
  // and the returned string is the authoritative final answer for callers that
  // commit/persist it.
  return resolveAskAnswer(
    prompt,
    request.provider,
    request.model,
    request.messages,
    options,
    onToken,
  );
}
