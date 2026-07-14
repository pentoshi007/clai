import { runAgentLoop } from "../../agent/runner.js";
import type { AgentPort } from "../ports/agent-port.js";

/**
 * Wraps the existing `runAgentLoop` behind `AgentPort` without altering agent
 * semantics (CORE-001). Readonly request arrays are copied to the mutable
 * shapes the runner expects.
 */
export function createCurrentAgentPort(): AgentPort {
  return {
    runTurn(request, handlers) {
      return runAgentLoop(request.prompt, {
        provider: request.provider,
        model: request.model,
        history: request.history ? [...request.history] : undefined,
        images: request.images ? [...request.images] : undefined,
        autoConfirm: request.autoConfirm,
        maxSteps: request.maxSteps,
        onEvent: handlers.onEvent,
        onMessages: handlers.onMessages,
        signal: handlers.signal,
        confirm: handlers.confirm,
        requestSecret: handlers.requestSecret,
        session: handlers.session,
      });
    },
  };
}
