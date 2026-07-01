import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatImage, ChatMessage, ProviderId } from "../../types.js";
import type { AgentEvent } from "../../agent/events.js";
import { runAgent } from "../../modes/agent.js";
import { runAskStream, type AskActionRequired } from "../../modes/ask.js";
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

/**
 * High-frequency streaming events (`assistant-delta`, `thinking-delta`) can
 * arrive dozens of times per second from fast providers like Gemini Flash.
 * Dispatching each one to the reducer triggers a full Ink re-render, and the
 * TUI re-renders the entire transcript per render — so an unbatched stream
 * makes the screen crawl and appear to hang as the answer grows.
 *
 * This wrapper coalesces consecutive delta tokens into a single dispatch on a
 * short timer (so the screen updates ~25x/sec instead of per token), while
 * forwarding every other event immediately. Pending deltas are always flushed
 * *before* a non-delta event so transcript ordering is preserved (e.g. the
 * streamed prose lands before the tool card that supersedes it).
 */
export interface ThrottledDispatch {
  dispatch: (event: AgentEvent) => void;
  /** Flush any buffered deltas immediately (call when a turn ends/aborts). */
  flush: () => void;
}

export function createThrottledDispatch(
  dispatch: (event: AgentEvent) => void,
  intervalMs = 40,
): ThrottledDispatch {
  let pendingAssistant = "";
  let pendingThinking = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pendingAssistant) {
      const text = pendingAssistant;
      pendingAssistant = "";
      dispatch({ type: "assistant-delta", text });
    }
    if (pendingThinking) {
      const text = pendingThinking;
      pendingThinking = "";
      dispatch({ type: "thinking-delta", text });
    }
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(flush, intervalMs);
  };

  const throttled = (event: AgentEvent): void => {
    if (event.type === "assistant-delta") {
      pendingAssistant += event.text;
      schedule();
      return;
    }
    if (event.type === "thinking-delta") {
      pendingThinking += event.text;
      schedule();
      return;
    }
    // Any other event: flush buffered deltas first to keep ordering, then
    // forward the event so it commits after the text it follows.
    flush();
    dispatch(event);
  };

  return { dispatch: throttled, flush };
}

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
  /**
   * Called when the user confirms switching from ask mode into agent mode for
   * an action task. The App uses this to flip its mode state (and persist the
   * default) so subsequent turns stay in agent mode.
   */
  onSwitchToAgent?: () => void;
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
  setMessages: (messages: ChatMessage[], sessionId?: string) => void;
  compact: (sessionTranscript?: string, keepRecent?: number, signal?: AbortSignal) => Promise<CompactResult>;
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
  onSwitchToAgent,
}: UseAgentRunnerArgs): AgentRunner {
  const messagesRef = useRef<ChatMessage[]>([]);
  const sessionRef = useRef<SessionPolicy>(createSessionPolicy());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runningRef = useRef(false);

  // Coalesce high-frequency streaming deltas so a fast provider doesn't force
  // a full-transcript Ink re-render per token. Recreated only if the
  // underlying dispatch changes (it shouldn't during a session).
  const throttled = useMemo(
    () => createThrottledDispatch(dispatchEvent),
    [dispatchEvent],
  );
  // Belt-and-braces: flush any buffered deltas if the hook unmounts mid-stream.
  useEffect(() => () => throttled.flush(), [throttled]);

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

  const setMessages = useCallback((messages: ChatMessage[], sessionId?: string) => {
    messagesRef.current = [...messages];
    sessionRef.current = createSessionPolicy(sessionId);
  }, []);

  const compact = useCallback(async (sessionTranscript?: string, keepRecent?: number, signal?: AbortSignal) => {
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
        signal,
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
          signal?.throwIfAborted();
          partials.push(await completeSummary(
            `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunks[index]}`,
          ));
        }
        signal?.throwIfAborted();
        return completeSummary(
          "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
          partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
        );
      },
      { budgetTokens: 0, keepRecent },
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
          throttled.dispatch({ type: "turn-start", prompt: input });
          throttled.dispatch({ type: "status", text: "thinking" });
          const parser = createThinkingStreamParser(
            (visible) => throttled.dispatch({ type: "assistant-delta", text: visible }),
            (think) => throttled.dispatch({ type: "thinking-delta", text: think }),
          );
          let sawToken = false;
          let actionInfo: AskActionRequired | undefined;
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
              onActionRequired: (info) => {
                actionInfo = info;
              },
              // Render read-only research (web.search/web.fetch/…) as tool
              // cards, exactly like agent-mode tool activity.
              onEvent: throttled.dispatch,
            },
          );
          // Flush the live-display parser, but trust the returned text as the
          // authoritative answer: when ask mode runs research rounds the live
          // stream may briefly mirror a tool-call preamble, whereas the return
          // value is always the clean final answer.
          if (sawToken) parser.finish();

          if (actionInfo) {
            // Ask mode can't perform the requested action. Show the model's
            // explanation, then offer to switch into agent mode and run it.
            throttled.flush();
            if (actionInfo.preamble) {
              throttled.dispatch({
                type: "assistant-message",
                text: actionInfo.preamble,
              });
            }
            const proceed = confirm.confirmAgentSwitch
              ? await confirm.confirmAgentSwitch({
                  reason: actionInfo.preamble,
                  tools: actionInfo.tools,
                })
              : false;
            if (proceed) {
              onSwitchToAgent?.();
              // Re-run the original request through the agent loop. runAgent
              // emits its own turn-start/turn-end via onEvent.
              answer = await runAgent(actionInfo.prompt, {
                provider: ctx.provider,
                model: ctx.model,
                history: messagesRef.current.slice(0, -1),
                signal: ac.signal,
                session: sessionRef.current,
                images: opts?.images,
                onEvent: throttled.dispatch,
                confirm,
                requestSecret,
              });
            } else {
              answer =
                "Staying in ask mode; the task wasn't run. Use /agent to run tasks that take actions.";
              throttled.dispatch({ type: "assistant-message", text: answer });
              throttled.dispatch({
                type: "turn-end",
                finalAnswer: answer,
                steps: 1,
              });
            }
          } else {
            const result = rememberThinkingFromText(raw);
            if (result.hasThinking && result.thinkContent) {
              throttled.dispatch({
                type: "thinking-block",
                content: result.thinkContent,
              });
            }
            answer = result.visible;
            throttled.dispatch({ type: "assistant-message", text: answer });
            throttled.dispatch({
              type: "turn-end",
              finalAnswer: answer,
              steps: 1,
            });
          }
        } else {
          answer = await runAgent(input, {
            provider: ctx.provider,
            model: ctx.model,
            history: messagesRef.current.slice(0, -1),
            signal: ac.signal,
            session: sessionRef.current,
            images: opts?.images,
            onEvent: throttled.dispatch,
            confirm,
            requestSecret,
          });
        }
        messagesRef.current.push({ role: "assistant", content: answer });
      } catch (err) {
        if (ac.signal.aborted) {
          throttled.dispatch({ type: "turn-aborted" });
        } else if (ctx.mode === "ask") {
          throttled.dispatch({
            type: "turn-error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        throttled.flush();
        process.off("SIGINT", onSigint);
        runningRef.current = false;
        abortRef.current = undefined;
      }
    },
    [throttled, confirm, getContext, requestSecret, onSwitchToAgent],
  );

  return useMemo<AgentRunner>(
    () => ({ isRunning, run, abort, reset, getSession, getMessages, setMessages, compact }),
    [isRunning, run, abort, reset, getSession, getMessages, setMessages, compact],
  );
}
