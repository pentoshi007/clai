import type {
  ChatMessage,
  ChatImage,
  CompletionResult,
  NativeToolCall,
  ProviderId,
  ToolCall,
} from "../types.js";
import type { AgentEvent } from "../agent/events.js";
import { streamWithProvider } from "../llm/router.js";
import { modelSupportsVision, resolveToolDialect } from "../llm/capabilities.js";
import { syntheticToolCallId } from "../llm/tool-protocol.js";
import {
  renderAskSystemPrompt,
  renderRequestEnvironmentContext,
} from "../prompts/index.js";
import { getConfig, getProviderModel } from "../store/config.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { loadProjectContext } from "../store/project.js";
import { loadAgentInstructions } from "../instructions/load.js";
import { safeCwd } from "../os/cwd.js";
import { parseAllToolCalls, formatToolArgs, looksLikePromptLeak } from "../agent/runner.js";
import { runToolCall } from "../tools/registry.js";
import { getToolDefinitions } from "../tools/definitions.js";
import {
  appendAssistantWithTools,
  appendToolResult,
  ensureUniqueToolCallIds,
  toolCallIdsInHistory,
} from "../agent/tool-history.js";


export interface AskActionRequired {
  prompt: string;
  preamble: string;
  tools: string[];
}

export interface AskOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
  
  onActionRequired?: ((info: AskActionRequired) => void) | undefined;
 
  onEvent?: ((event: AgentEvent) => void) | undefined;
}

function stripToolCallSyntax(text: string): string {
  return text
    .replace(/```tool\s*\n?[\s\S]*?```/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[\w.]+?>[\s\S]*?<\/function>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildActionRequiredMessage(info: AskActionRequired): string {
  const lead = info.preamble ? `${info.preamble}\n\n` : "";
  const tools =
    info.tools.length > 0 ? ` (it wants to run: ${info.tools.join(", ")})` : "";
  return (
    `${lead}This request needs to take actions${tools}, which ask mode can't do — ` +
    "it's read-only. Switch to agent mode with `/agent` and run it there."
  );
}

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
    case "image.view":
      return "image attached for visual inspection";
    default:
      return "done";
  }
}



const ASK_RESEARCH_TOOLS = new Set([
  "web.search",
  "web.fetch",
  "tool.batch",
  "fs.read",
  "fs.list",
  "fs.search",
  "image.view",
]);

const ASK_MAX_RESEARCH_ROUNDS = 5;
const ASK_MAX_TOOLS_PER_ROUND = 4;
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
  const model = options.model ?? getProviderModel(provider);
  const projectContext = await loadProjectContext();
  const instructions = await loadAgentInstructions({ cwd: safeCwd() }).catch(
    () => undefined,
  );
  const native =
    resolveToolDialect(provider, model, config.toolCalling) !== "none";
  const systemPrompt = renderAskSystemPrompt({
    nativeTools: native,
    stableEnvironment: true,
    imageView: modelSupportsVision(provider, model),
  });
  const userMessage: ChatMessage = { role: "user", content: prompt };
  if (options.images && options.images.length > 0) {
    userMessage.images = options.images;
  }
  return {
    provider,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...(options.history ?? []),
      {
        role: "system",
        content: [
          "REQUEST CONTEXT",
          renderRequestEnvironmentContext(),
          ...(instructions?.block ? [instructions.block] : []),
          ...(projectContext
            ? [`Project context from .clai/context.md:\n${projectContext}`]
            : []),
        ].join("\n\n"),
      },
      userMessage,
    ],
  };
}


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
  tools?: ReturnType<typeof getToolDefinitions> | undefined;
  toolChoice?: "auto" | undefined;
}


async function streamAskRound(
  request: AskBaseRequest,
  messages: ChatMessage[],
  onToken: (token: string) => void,
): Promise<{
  text: string;
  provider: ProviderId;
  model: string;
  toolCalls?: NativeToolCall[];
  nativeIds?: string[];
  reasoningBlock?: CompletionResult["reasoningBlock"];
  reasoningArtifacts?: CompletionResult["reasoningArtifacts"];
}> {
  let full = "";
  let forwardedLen = 0;
  let suppressed = false;
  const completion = await streamWithProvider(
    { ...request, messages },
    (token) => {
      full += token;
      if (suppressed) return;
      const toolAt = toolCallStartIndex(full);
      if (toolAt >= 0) {
        if (toolAt > forwardedLen) onToken(full.slice(forwardedLen, toolAt));
        forwardedLen = full.length;
        suppressed = true;
        return;
      }
      if (full.length > forwardedLen) {
        onToken(full.slice(forwardedLen));
        forwardedLen = full.length;
      }
    },
  );
  const text = full || completion.text;
  if (completion.toolCalls?.length) {
    return {
      text,
      provider: completion.provider,
      model: completion.model,
      toolCalls: completion.toolCalls,
      nativeIds: completion.toolCalls.map((tc) => tc.id),
      ...(completion.reasoningBlock
        ? { reasoningBlock: completion.reasoningBlock }
        : {}),
      ...(completion.reasoningArtifacts
        ? { reasoningArtifacts: completion.reasoningArtifacts }
        : {}),
    };
  }
  return {
    text,
    provider: completion.provider,
    model: completion.model,
  };
}


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
  const askDefinitions = (
    routeProvider: ProviderId,
    routeModel: string,
  ): ReturnType<typeof getToolDefinitions> | undefined => {
    const native =
      resolveToolDialect(routeProvider, routeModel, config.toolCalling) !== "none";
    if (!native) return undefined;
    return [
      ...getToolDefinitions({ askMode: true }).filter(
        (definition) =>
          ASK_RESEARCH_TOOLS.has(definition.name) &&
          (definition.name !== "image.view" ||
            modelSupportsVision(routeProvider, routeModel)),
      ),
      ...getToolDefinitions({ names: ["agent.handoff"] }),
    ];
  };
  const buildBaseRequest = (
    routeProvider: ProviderId,
    routeModel: string,
  ): AskBaseRequest => {
    const definitions = askDefinitions(routeProvider, routeModel);
    return {
      provider: routeProvider,
      model: routeModel,
      temperature: 0.2,
      maxTokens,
      thinking: config.thinking,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(definitions?.length
        ? { tools: definitions, toolChoice: "auto" as const }
        : {}),
    };
  };
  const updateSystemPromptForRoute = (
    routeProvider: ProviderId,
    routeModel: string,
  ): void => {
    if (messages[0]?.role !== "system") return;
    const native =
      resolveToolDialect(routeProvider, routeModel, config.toolCalling) !== "none";
    messages[0] = {
      ...messages[0],
      content: renderAskSystemPrompt({
        nativeTools: native,
        stableEnvironment: true,
        imageView: modelSupportsVision(routeProvider, routeModel),
      }),
    };
  };
  let activeProvider = provider;
  let activeModel = model;
  let baseRequest = buildBaseRequest(activeProvider, activeModel);

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
        "Answer from these current results. Prefer high-trust hosts (.gov, major news). Treat a single junk/contradictory snippet as unverified until confirmed. If insufficient, call web.search/web.fetch again before answering. Your final answer MUST cite 1–3 URLs from tool results.",
    });
  }

  for (let round = 0; round < ASK_MAX_RESEARCH_ROUNDS; round += 1) {
    options.signal?.throwIfAborted();
    const roundResult = await streamAskRound(baseRequest, messages, onToken);
    activeProvider = roundResult.provider;
    activeModel = roundResult.model;
    baseRequest = buildBaseRequest(activeProvider, activeModel);
    updateSystemPromptForRoute(activeProvider, activeModel);
    const text = roundResult.text;

    
    if (looksLikePromptLeak(text)) {
      return text;
    }

    const allCalls: ToolCall[] =
      roundResult.toolCalls?.length
        ? roundResult.toolCalls
        : parseAllToolCalls(text);
    const nativeIds =
      roundResult.nativeIds ??
      allCalls.map((_, i) => syntheticToolCallId(i));
    const researchCalls = allCalls
      .map((call, sourceIndex) => ({ call, sourceIndex }))
      .filter(({ call }) => ASK_RESEARCH_TOOLS.has(call.name));
    if (researchCalls.length === 0) {
      
      const actionCalls = allCalls.filter(
        (call) => !ASK_RESEARCH_TOOLS.has(call.name),
      );
      if (actionCalls.length > 0) {
       
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
        const tail = info.preamble ? message.slice(info.preamble.length) : message;
        if (tail) onToken(tail);
        return message;
      }
      return text;
    }
    const historyNativeCalls = roundResult.toolCalls?.length
      ? ensureUniqueToolCallIds(
          roundResult.toolCalls.map((c, index) => ({
            id: nativeIds[index] ?? syntheticToolCallId(index),
            name: c.name,
            args: c.args,
            ...(c.thoughtSignature
              ? { thoughtSignature: c.thoughtSignature }
              : {}),
          })),
          toolCallIdsInHistory(messages),
        )
      : [];
    if (historyNativeCalls.length) {
      appendAssistantWithTools(
        messages,
        stripToolCallSyntax(text),
        historyNativeCalls,
        roundResult.reasoningBlock,
        roundResult.reasoningArtifacts,
      );
    } else {
      messages.push({ role: "assistant", content: text });
    }
    const viewedImages: ChatImage[] = [];
    const completedNativeCallIndices = new Set<number>();
    for (const [callIndex, { call, sourceIndex }] of researchCalls
      .slice(0, ASK_MAX_TOOLS_PER_ROUND)
      .entries()) {
      completedNativeCallIndices.add(sourceIndex);
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
      let resultImages: ChatImage[] | undefined;
      try {
        const toolResult = await runToolCall(call, {
          ...(options.signal ? { signal: options.signal } : {}),
          llmProvider: activeProvider,
          llmModel: activeModel,
        });
        output = toolResult.output;
        ok = toolResult.ok;
        resultImages = toolResult.images;
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
      const resultBody = `Result of ${call.name}(${JSON.stringify(call.args)}):\n${truncateToolOutput(output, call.name)}`;
      if (resultImages?.length) viewedImages.push(...resultImages);
      if (historyNativeCalls.length) {
        appendToolResult(
          messages,
          historyNativeCalls[sourceIndex]?.id ?? syntheticToolCallId(callIndex),
          resultBody,
          call.name,
          ok,
        );
      } else {
        messages.push({
          role: "user",
          content: resultBody,
        });
      }
    }
    if (historyNativeCalls.length) {
      for (const [sourceIndex, omitted] of allCalls.entries()) {
        if (completedNativeCallIndices.has(sourceIndex)) continue;
        const reason = ASK_RESEARCH_TOOLS.has(omitted.name)
          ? `Skipped ${omitted.name}: Ask mode executes at most ${ASK_MAX_TOOLS_PER_ROUND} read-only tools per research round.`
          : `Skipped ${omitted.name}: it is not a read-only research tool and cannot be combined with this research tool-call group.`;
        appendToolResult(
          messages,
          historyNativeCalls[sourceIndex]?.id ?? syntheticToolCallId(sourceIndex),
          reason,
          omitted.name,
          false,
        );
      }
    }
    if (viewedImages.length > 0) {
      messages.push({
        role: "user",
        internal: true,
        content:
          `${viewedImages.length === 1 ? "The image" : `The ${viewedImages.length} images`} requested through image.view ` +
          `${viewedImages.length === 1 ? "is" : "are"} attached now. Inspect the actual pixels before answering.`,
        images: viewedImages,
      });
    }
  }

  options.signal?.throwIfAborted();
  messages.push({
    role: "user",
    content:
      "Stop researching now. Using only what you have already gathered above, give your final answer to the original question. Do NOT call any more tools. Prefer high-trust sources; only claim a page confirms a fact if that fact appears in the tool output; include 1–3 source URLs from the results above.",
  });
  const finalRound = await streamAskRound(baseRequest, messages, onToken);
  return finalRound.text;
}

export async function runAsk(
  prompt: string,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
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
 
  return resolveAskAnswer(
    prompt,
    request.provider,
    request.model,
    request.messages,
    options,
    onToken,
  );
}
