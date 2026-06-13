import type { ChatMessage, ChatImage, ProviderId } from "../types.js";
import { completeWithProvider } from "../llm/router.js";
import { renderAskSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { loadProjectContext } from "../store/project.js";
import { parseAllToolCalls } from "../agent/runner.js";
import { runToolCall } from "../tools/registry.js";

export interface AskOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
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

function truncateToolOutput(text: string): string {
  return text.length > ASK_TOOL_OUTPUT_CAP
    ? `${text.slice(0, ASK_TOOL_OUTPUT_CAP)}\n…[truncated — call web.fetch on a specific url for more]`
    : text;
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
 * Drive ask mode to its final answer.
 *
 * Ask mode is non-agentic for the user — there is no plan, no confirmations,
 * no system changes — but it MAY ground its answer in current facts via a
 * bounded loop of read-only tools (web.search/web.fetch/tool.batch and
 * read-only fs.*). We run those rounds with non-streaming completions and
 * return the final answer text; the caller emits it. Returning the whole
 * answer at once (rather than live token streaming) also means tables and
 * other block markdown render from a complete document instead of a
 * half-streamed one.
 */
async function resolveAskAnswer(
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
  options: AskOptions,
): Promise<string> {
  const config = getConfig();
  const maxTokens = config.thinking?.enabled ? 8_192 : 4_096;
  const baseRequest = {
    provider,
    model,
    temperature: 0.2,
    maxTokens,
    thinking: config.thinking,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  for (let round = 0; round < ASK_MAX_RESEARCH_ROUNDS; round += 1) {
    options.signal?.throwIfAborted();
    const result = await completeWithProvider({ ...baseRequest, messages });
    const calls = parseAllToolCalls(result.text).filter((call) =>
      ASK_RESEARCH_TOOLS.has(call.name),
    );
    if (calls.length === 0) {
      // No (allowed) tool requested → this completion is the final answer.
      return result.text;
    }
    // Record the model's tool-call turn, then run the read-only tools and
    // feed their outputs back so the next round can synthesize.
    messages.push({ role: "assistant", content: result.text });
    for (const call of calls.slice(0, ASK_MAX_TOOLS_PER_ROUND)) {
      options.signal?.throwIfAborted();
      let output: string;
      try {
        const toolResult = await runToolCall(call, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        output = toolResult.output;
      } catch (err) {
        output = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({
        role: "user",
        content: `Result of ${call.name}(${JSON.stringify(call.args)}):\n${truncateToolOutput(output)}`,
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
  const final = await completeWithProvider({ ...baseRequest, messages });
  return final.text;
}

export async function runAsk(
  prompt: string,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  return resolveAskAnswer(
    request.provider,
    request.model,
    request.messages,
    options,
  );
}

export async function runAskStream(
  prompt: string,
  onToken: (token: string) => void,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  const answer = await resolveAskAnswer(
    request.provider,
    request.model,
    request.messages,
    options,
  );
  // The research loop is non-streaming; deliver the completed answer in one
  // chunk so the caller's markdown/thinking pipeline renders a whole document.
  if (answer.length > 0) onToken(answer);
  return answer;
}
