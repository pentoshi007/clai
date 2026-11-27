import { runAgentTurn } from "../../agent/runner.js";
import { createToolRouting, shouldUseCompactSystemPrompt } from "../../agent/turn/tool-routing.js";
import { effectiveContextWindowTokens, providerInputTokenBudget } from "../../llm/context-windows.js";
import type { McpRuntime } from "../../mcp/runtime.js";
import { getConfig } from "../../store/config.js";
import type { AgentPort } from "../ports/agent-port.js";

export interface CurrentAgentPortOptions {
  readonly mcp?: McpRuntime | undefined;
}

export function createCurrentAgentPort(
  options: CurrentAgentPortOptions = {},
): AgentPort {
  return {
    reportsModelSubmission: true,
    requestPrefix({ provider, model, mode, contextLimitTokens }, session) {
      const config = getConfig();
      const useCompactSystemPrompt = shouldUseCompactSystemPrompt(
        providerInputTokenBudget(provider, model),
        effectiveContextWindowTokens(provider, model, contextLimitTokens),
      );
      const routing = createToolRouting({
        mode,
        mcpPresent: Boolean(options.mcp),
        subagents: session.subagents?.enabled ?? false,
        toolCalling: config.toolCalling,
        useCompactSystemPrompt: () => useCompactSystemPrompt,
        compactPromptModes: new Map(session.compactPromptModes),
      });
      const { native } = routing.resolveNativeTools(provider, model);
      return {
        systemPrompt: routing.buildStableSystemContent(native, provider, model),
        tools: routing.selectToolDefs(native, useCompactSystemPrompt, provider, model),
        thinking: config.thinking,
      };
    },
    runTurn(request, handlers) {
      return runAgentTurn(request.prompt, {
        ...(options.mcp ? { mcp: options.mcp } : {}),
        provider: request.provider,
        model: request.model,
        history: request.history ? [...request.history] : undefined,
        images: request.images ? [...request.images] : undefined,
        visionProven: request.visionProven,
        autoConfirm: request.autoConfirm,
        maxSteps: request.maxSteps,
        onEvent: handlers.onEvent,
        onMessages: handlers.onMessages,
        onSuccessfulRequest: handlers.onSuccessfulRequest,
        signal: handlers.signal,
        confirm: handlers.confirm,
        requestSecret: handlers.requestSecret,
        askUser: handlers.askUser,
        session: handlers.session,
        mode: request.mode,
        displayPrompt: request.displayPrompt,
        previousTurn: request.previousTurn,
        ...(request.previousSuccessfulRequest
          ? { previousSuccessfulRequest: request.previousSuccessfulRequest }
          : {}),
        ...(request.providerReportedContextTokens !== undefined
          ? { providerReportedContextTokens: request.providerReportedContextTokens }
          : {}),
        contextLimitTokens: request.contextLimitTokens,
        ...(request.getContextLimitTokens
          ? { getContextLimitTokens: request.getContextLimitTokens }
          : {}),
      });
    },
  };
}
