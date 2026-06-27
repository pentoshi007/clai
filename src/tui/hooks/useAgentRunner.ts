import { useCallback, useMemo, useRef } from "react";
import type { ChatImage, ChatMessage, ProviderId } from "../../types.js";
import type { AgentEvent } from "../../agent/events.js";
import { runAgent } from "../../modes/agent.js";
import { runAskStream } from "../../modes/ask.js";
import {
  createSessionPolicy,
  type SessionPolicy,
} from "../../agent/runner.js";
import { compactMessages } from "../../agent/context-manager.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
} from "../../ui/thinking.js";
import type { ConfirmPort } from "../../agent/runner.js";

export interface RunnerContext {
  mode: "ask" | "agent";
  provider?: ProviderId | undefined;
  model?: string | undefined;
}

export interface RunOptions {
  images?: ChatImage[] | undefined;
}

export interface UseAgentRunnerArgs {
  dispatchEvent: (event: AgentEvent) => void;
  confirm: ConfirmPort;
  getContext: () => RunnerContext;
}

export interface AgentRunner {
  /** True while a turn is in flight. */
  isRunning: () => boolean;
  /** Start a turn for `input`. Resolves when the turn finishes. */
  run: (input: string, opts?: RunOptions) => Promise<void>;
  /** Abort the current turn (model stream + foreground tool). */
  abort: () => void;
  /** Clear conversation history and session policy (for /clear, /new). */
  reset: () => void;
  /** The live session policy (sessionId, planApproved, allow set). */
  getSession: () => SessionPolicy;
  /** Snapshot of the conversation messages (for /context, /save). */
  getMessages: () => ChatMessage[];
  /** Compact the in-memory history; returns counts before/after. */
  compact: () => { before: number; after: number };
}

/**
 * Bridges the React UI to the single agent implementation. On submit it
 * creates an AbortController, calls `runAgent`/`runAskStream` with
 * `onEvent: dispatchEvent`, and keeps conversation history so follow-ups
 * have context — mirroring the classic REPL's session handling.
 */
export function useAgentRunner({
  dispatchEvent,
  confirm,
  getContext,
}: UseAgentRunnerArgs): AgentRunner {
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionRef = useRef<SessionPolicy>(createSessionPolicy());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runningRef = useRef(false);

  const isRunning = useCallback(() => runningRef.current, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    messagesRef.current = [];
    sessionRef.current = createSessionPolicy();
  }, []);

  const getSession = useCallback(() => sessionRef.current, []);

  const getMessages = useCallback(() => [...messagesRef.current], []);

  const compact = useCallback(() => {
    const before = messagesRef.current.length;
    messagesRef.current = compactMessages(messagesRef.current, { budgetTokens: 0 });
    return { before, after: messagesRef.current.length };
  }, []);

  const run = useCallback(
    async (input: string, opts?: RunOptions): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      const ctx = getContext();
      const ac = new AbortController();
      abortRef.current = ac;
      messagesRef.current.push({ role: "user", content: input });

      try {
        let answer = "";
        if (ctx.mode === "ask") {
          dispatchEvent({ type: "turn-start", prompt: input });
          dispatchEvent({ type: "status", text: "thinking" });
          const parser = createThinkingStreamParser(
            (visible) => dispatchEvent({ type: "assistant-delta", text: visible }),
            (think) => dispatchEvent({ type: "thinking-delta", text: think }),
          );
          let sawToken = false;
          const raw = await runAskStream(
            input,
            (token) => {
              sawToken = true;
              parser.push(token);
            },
            {
              provider: ctx.provider,
              model: ctx.model,
              history: messagesRef.current.slice(0, -1),
              signal: ac.signal,
            },
          );
          const result = sawToken ? parser.finish() : rememberThinkingFromText(raw);
          if (result.hasThinking && result.thinkContent) {
            dispatchEvent({ type: "thinking-block", content: result.thinkContent });
          }
          answer = result.visible;
          dispatchEvent({ type: "assistant-message", text: answer });
          dispatchEvent({ type: "turn-end", finalAnswer: answer, steps: 1 });
        } else {
          answer = await runAgent(input, {
            provider: ctx.provider,
            model: ctx.model,
            history: messagesRef.current.slice(0, -1),
            signal: ac.signal,
            session: sessionRef.current,
            images: opts?.images,
            onEvent: dispatchEvent,
            confirm,
          });
        }
        messagesRef.current.push({ role: "assistant", content: answer });
      } catch (err) {
        if (ac.signal.aborted) {
          dispatchEvent({ type: "turn-aborted" });
        } else {
          dispatchEvent({
            type: "turn-error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        runningRef.current = false;
        abortRef.current = undefined;
      }
    },
    [dispatchEvent, confirm, getContext],
  );

  return useMemo<AgentRunner>(
    () => ({ isRunning, run, abort, reset, getSession, getMessages, compact }),
    [isRunning, run, abort, reset, getSession, getMessages, compact],
  );
}
