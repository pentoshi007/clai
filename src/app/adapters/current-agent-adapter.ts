import { runAgentTurn } from "../../agent/runner.js";
import type { AgentPort } from "../ports/agent-port.js";


export function createCurrentAgentPort(): AgentPort {
  return {
    runTurn(request, handlers) {
      return runAgentTurn(request.prompt, {
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
        session: handlers.session,
        mode: request.mode,
        displayPrompt: request.displayPrompt,
        previousTurn: request.previousTurn,
        ...(request.previousSuccessfulRequest
          ? { previousSuccessfulRequest: request.previousSuccessfulRequest }
          : {}),
        contextLimitTokens: request.contextLimitTokens,
        ...(request.getContextLimitTokens
          ? { getContextLimitTokens: request.getContextLimitTokens }
          : {}),
      });
    },
  };
}
