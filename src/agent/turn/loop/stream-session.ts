import type { NativeToolCall, SuccessfulRequestSnapshot, ToolCall, ToolCallStreamDelta } from "../../../types.js";
import type { ProviderStreamEvent } from "../../../llm/stream-events.js";
import { createThinkingStreamParser } from "../../../ui/thinking.js";
import { parseAllToolCalls } from "../../tool-call-parser.js";
import { canonicalizeTurnCall, type ToolNameCanonicalizer } from "./canonicalize-turn-call.js";
import { isProviderFailureStatus, providerWaitLabel } from "../../../llm/key-rotation.js";
import { createPendingToolCalls, type PendingToolCallPorts } from "./pending-tool-calls.js";

const HEARTBEAT_MS = 10_000;

export interface StreamDeferredToolCall {
  readonly eventId: string;
  call: ToolCall;
  shown: boolean;
}

export interface StreamSessionPorts extends PendingToolCallPorts {
  readonly emitStatus: (text: string) => void;
  readonly emitAssistantDelta: (text: string) => void;
  readonly emitThinkingDelta: (text: string) => void;
  readonly writeStatus: (text: string) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly writeToolCall: (eventId: string, call: ToolCall) => void;
  readonly nextToolEventId: () => string;
  readonly markPrinted: (eventId: string) => void;
  readonly nativeToolsAttached: () => boolean;
  readonly mcpRuntime?: ToolNameCanonicalizer | undefined;
  readonly onSuccessfulRequest: (snapshot: SuccessfulRequestSnapshot) => void;
}

export interface StreamSession {
  readonly accumulatedText: () => string;
  readonly streamedReasoningText: () => string;
  readonly sawReasoning: () => boolean;
  readonly deferredToolCalls: StreamDeferredToolCall[];
  readonly streamedNativeCallNames: Map<number, string>;
  readonly callIds: string[];
  readonly onToken: (token: string) => void;
  readonly onStatus: (status: string) => void;
  readonly onStreamEvent: (event: ProviderStreamEvent) => void;
  readonly onToolCallDelta: (delta: ToolCallStreamDelta) => void;
  readonly finishToolCalls: (calls?: readonly NativeToolCall[]) => void;
  readonly onSuccessfulRequest: (snapshot: SuccessfulRequestSnapshot) => void;
  readonly finishDeltaParser: () => void;
  readonly stopHeartbeat: () => void;
}

interface StreamState {
  waitingForProvider: boolean;
  sawReasoning: boolean;
  inThinking: boolean;
  emittedThinkingStatus: boolean;
  generatedTokens: number;
  accumulatedText: string;
  streamedReasoningText: string;
  typedReasoningOpen: boolean;
  streamedCallsCount: number;
  toolStatus?: string | undefined;
}

const streamPhase = (state: StreamState): string => {
  if (state.toolStatus) return state.toolStatus;
  if (state.generatedTokens > 0 && !state.inThinking) return "responding";
  if (state.sawReasoning) return "thinking";
  return "waiting";
};

const emitStreamedTextCards = (
  ports: StreamSessionPorts,
  state: StreamState,
  session: {
    deferredToolCalls: StreamDeferredToolCall[];
    callIds: string[];
  },
): void => {
  const parsedCalls = parseAllToolCalls(state.accumulatedText);
  while (state.streamedCallsCount < parsedCalls.length) {
    const call = canonicalizeTurnCall(
      parsedCalls[state.streamedCallsCount]!,
      ports.mcpRuntime,
    );
    const eventId = ports.nextToolEventId();
    session.callIds[state.streamedCallsCount] = eventId;
    ports.markPrinted(eventId);
    session.deferredToolCalls.push({ eventId, call, shown: true });
    ports.writeToolCall(eventId, call);
    ports.emitStatus(call.name);
    state.streamedCallsCount += 1;
  }
};

const applyThinkingTransitions = (
  ports: StreamSessionPorts,
  state: StreamState,
  token: string,
): void => {
  if (state.typedReasoningOpen) {
    state.typedReasoningOpen = false;
    state.inThinking = false;
    state.generatedTokens = 0;
  }
  if (
    !state.sawReasoning &&
    /^\s*<think(?:ing)?\b/i.test(state.accumulatedText)
  ) {
    state.sawReasoning = true;
    state.inThinking = true;
    ports.emitStatus("thinking");
  }
  if (state.inThinking && /<\/think(?:ing)?>/i.test(token)) {
    state.inThinking = false;
    state.generatedTokens = 0;
  }
};

const applyReasoningDelta = (
  ports: StreamSessionPorts,
  state: StreamState,
  text: string,
): void => {
  state.waitingForProvider = false;
  state.toolStatus = undefined;
  state.streamedReasoningText += text;
  state.typedReasoningOpen = true;
  state.sawReasoning = true;
  state.inThinking = true;
  state.generatedTokens += 1;
  if (!state.emittedThinkingStatus) {
    state.emittedThinkingStatus = true;
    ports.emitStatus("thinking");
  }
  ports.emitThinkingDelta(text);
};

const routeProviderStatus = (
  ports: StreamSessionPorts,
  state: StreamState,
  status: string,
): void => {
  const full = status.replace(/\s+/g, " ").trim();
  if (!full) return;
  const waiting = providerWaitLabel(full);
  if (waiting) {
    state.waitingForProvider = true;
    state.emittedThinkingStatus = false;
    ports.writeStatus(waiting);
    return;
  }
  const warning = !full.startsWith("ℹ") &&
    (isProviderFailureStatus(full) || /\b(?:error|failed|exception)\b/i.test(full));
  ports.notify(warning ? "warn" : "info", full);
};

const createSessionDeltaParser = (ports: StreamSessionPorts, state: StreamState) =>
  createThinkingStreamParser(
    ports.emitAssistantDelta,
    (text) => {
      if (!state.emittedThinkingStatus) {
        state.emittedThinkingStatus = true;
        ports.emitStatus("thinking");
      }
      ports.emitThinkingDelta(text);
    },
  );

const initialStreamState = (): StreamState => ({
  waitingForProvider: false,
  sawReasoning: false,
  inThinking: false,
  emittedThinkingStatus: false,
  generatedTokens: 0,
  accumulatedText: "",
  streamedReasoningText: "",
  typedReasoningOpen: false,
  streamedCallsCount: 0,
});

function applyToolCallDelta(
  ports: StreamSessionPorts,
  state: StreamState,
  cards: ReturnType<typeof createPendingToolCalls>,
  delta: ToolCallStreamDelta,
): void {
  const observed = cards.observe(delta);
  if (!observed) return;
  state.waitingForProvider = false;
  state.inThinking = false;
  state.typedReasoningOpen = false;
  state.toolStatus = observed.status;
  if (observed.changed) ports.emitStatus(observed.status);
}

function routeStreamEvent(
  ports: StreamSessionPorts,
  state: StreamState,
  onToolCallDelta: (delta: ToolCallStreamDelta) => void,
  event: ProviderStreamEvent,
): void {
  if (event.type === "reasoning_delta") {
    applyReasoningDelta(ports, state, event.text);
    return;
  }
  if (event.type === "tool_call_started" || event.type === "tool_call_completed" || event.type === "tool_arguments_delta") {
    onToolCallDelta(event);
  }
}

export const createStreamSession = (
  ports: StreamSessionPorts,
): StreamSession => {
  const state = initialStreamState();
  const deferredToolCalls: StreamDeferredToolCall[] = [];
  const callIds: string[] = [];
  const cards = createPendingToolCalls(ports, callIds);
  const onToolCallDelta = (delta: ToolCallStreamDelta) => applyToolCallDelta(ports, state, cards, delta);
  const deltaParser = createSessionDeltaParser(ports, state);
  const heartbeat = setInterval(() => {
    if (!state.waitingForProvider) ports.emitStatus(streamPhase(state));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    accumulatedText: () => state.accumulatedText,
    streamedReasoningText: () => state.streamedReasoningText,
    sawReasoning: () => state.sawReasoning,
    deferredToolCalls,
    streamedNativeCallNames: cards.names,
    callIds,
    onToken: (token) => {
      if (!token) return;
      state.waitingForProvider = false;
      state.toolStatus = undefined;
      deltaParser.push(token);
      state.generatedTokens += 1;
      state.accumulatedText += token;
      if (!ports.nativeToolsAttached()) {
        emitStreamedTextCards(ports, state, { deferredToolCalls, callIds });
      }
      applyThinkingTransitions(ports, state, token);
    },
    onStatus: (status) => routeProviderStatus(ports, state, status),
    onStreamEvent: (event) => routeStreamEvent(ports, state, onToolCallDelta, event),
    onToolCallDelta,
    finishToolCalls: cards.finish,
    onSuccessfulRequest: ports.onSuccessfulRequest,
    finishDeltaParser: () => deltaParser.finish(),
    stopHeartbeat: () => clearInterval(heartbeat),
  };
};
