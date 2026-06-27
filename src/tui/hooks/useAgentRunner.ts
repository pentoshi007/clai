import { useCallback, useMemo, useRef } from "react";
import type { ChatImage, ChatMessage, ProviderId } from "../../types.js";
import type { AgentEvent } from "../../agent/events.js";
import { runAgent } from "../../modes/agent.js";
import { runAskStream } from "../../modes/ask.js";
import {
  createSessionPolicy,
  type SessionPolicy,
} from "../../agent/runner.js";
import { compactMessagesWithSummary, type CompactResult } from "../../agent/context-manager.js";
import { completeWithProvider } from "../../llm/router.js";
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
  requestSecret: (request: { title: string; prompt: string }) => Promise<string | undefined>;
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
  /** Replace the current conversation when resuming a saved session. */
  setMessages: (messages: ChatMessage[]) => void;
  /** Compact the in-memory history; returns counts before/after. */
  compact: (sessionTranscript?: string) => Promise<CompactResult>;
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
  requestSecret,
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

  const setMessages = useCallback((messages: ChatMessage[]) => {
    messagesRef.current = [...messages];
    sessionRef.current = createSessionPolicy();
  }, []);

  const compact = useCallback(async (sessionTranscript?: string) => {
    const ctx = getContext();
    const completeSummary = async (prompt: string): Promise<string> => {
      const response = await completeWithProvider({
        provider: ctx.provider,
        model: ctx.model,
        messages: [
          { role: "system", content: "You compress conversation history into accurate continuation memory." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        maxTokens: 2_048,
      });
      return response.text;
    };
    const result = await compactMessagesWithSummary(
      messagesRef.current,
      async (prompt) => {
        const chunkSize = 50_000;
        if (prompt.length <= chunkSize) return completeSummary(prompt);
        const chunks = Array.from(
          { length: Math.ceil(prompt.length / chunkSize) },
          (_, index) => prompt.slice(index * chunkSize, (index + 1) * chunkSize),
        );
        const partials: string[] = [];
        for (let index = 0; index < chunks.length; index += 1) {
          partials.push(await completeSummary(
            `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunks[index]}`,
          ));
        }
        return completeSummary(
          "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
        );
      },
      { budgetTokens: 0 },
      sessionTranscript,
    );
    messagesRef.current = result.messages;
    return result;
  }, [getContext]);

  const run = useCallback(
    async (input: string, opts?: RunOptions): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;
      const ctx = getContext();
      const ac = new AbortController();
      abortRef.current = ac;
      // Interactive children temporarily switch the shared terminal to cooked
      // mode. In that state Ink cannot receive Ctrl+C as a keypress, so catch
      // SIGINT here and translate it into the same turn abort. This prevents a
      // password prompt from requiring a second Ctrl+C that exits clai.
      const onSigint = (): void => ac.abort();
      process.on("SIGINT", onSigint);
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
              images: opts?.images,
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
            requestSecret,
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
        process.off("SIGINT", onSigint);
        runningRef.current = false;
        abortRef.current = undefined;
      }
    },
    [dispatchEvent, confirm, getContext, requestSecret],
  );

  return useMemo<AgentRunner>(
    () => ({ isRunning, run, abort, reset, getSession, getMessages, setMessages, compact }),
    [isRunning, run, abort, reset, getSession, getMessages, setMessages, compact],
  );
}
