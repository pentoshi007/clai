import { afterEach, expect, it, vi } from "vitest";
import {
  createStreamSession,
  type StreamSession,
  type StreamSessionPorts,
} from "../../src/agent/turn/loop/stream-session.js";
import { isProviderFailureStatus } from "../../src/llm/key-rotation.js";
import { formatActivity } from "../../src/ui-core/rendering/status-segments.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";

const sessions: StreamSession[] = [];
const credentialNotice = "Free: configured credential was rejected; retrying this free model with keyless access.";

function harness() {
  const ports: StreamSessionPorts = {
    emitStatus: vi.fn(), emitAssistantDelta: vi.fn(), emitThinkingDelta: vi.fn(),
    writeStatus: vi.fn(), notify: vi.fn(), writeToolCall: vi.fn(),
    writePendingToolCall: vi.fn(), writeToolBlocked: vi.fn(),
    nextToolEventId: () => "call-1", markPrinted: vi.fn(), nativeToolsAttached: () => true,
    onSuccessfulRequest: vi.fn(),
  };
  const session = createStreamSession(ports);
  sessions.push(session);
  return { ports, session };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.stopHeartbeat();
  vi.useRealTimers();
});

it.each([
  "Provider selected public access",
  "ℹ free/deepseek does not support native tools — falling back to text protocol",
  "ℹ openai/gpt-5 needs its reasoning replayed — retrying with it attached",
])("shows provider information as a toast, not activity: %s", status => {
  const { ports, session } = harness();
  session.onStatus(status);
  expect(ports.notify).toHaveBeenCalledWith("info", status);
  expect(ports.writeStatus).not.toHaveBeenCalled();
});

it.each([
  credentialNotice,
  "switching tokenrouter key [2/3] …ab12 (server error (502))",
  "switching gemini key [2/4] …cd34 (auth failed (401))",
  "switching gemini key [2/4] …cd34 (rate limited)",
  "all tokenrouter API keys failed",
])("shows provider/key failures as warning toasts: %s", status => {
  const { ports, session } = harness();
  session.onStatus(status);
  expect(ports.notify).toHaveBeenCalledWith("warn", status);
  expect(ports.writeStatus).not.toHaveBeenCalled();
});

it.each([
  ["⏳ free rate limited; staying on selected provider.", "rate limited"],
  ["⏳ tokenrouter [1/2] …ab12 server error (503) — retrying in 8s…", "retrying in 8s"],
  ["retrying in 8s (server-error)", "retrying in 8s"],
  ["⏳ free rate limited — retrying in 0.5s…", "retrying in 0.5s"],
])("keeps a concise wait label in the status bar: %s", (status, label) => {
  const { ports, session } = harness();
  session.onStatus(status);
  expect(ports.writeStatus).toHaveBeenCalledWith(label);
  expect(ports.notify).not.toHaveBeenCalled();
  expect(isProviderFailureStatus(status)).toBe(false);
  expect(isProviderFailureStatus(label)).toBe(false);
  expect(formatActivity(status, 28)).toBe(label);
});

it("does not overwrite a retry wait with the stream heartbeat", () => {
  vi.useFakeTimers();
  const { ports, session } = harness();
  session.onStatus("⏳ free rate limited — retrying in 20s…");
  vi.advanceTimersByTime(20_000);
  expect(ports.emitStatus).not.toHaveBeenCalled();
  session.onToken("OK");
  vi.advanceTimersByTime(10_000);
  expect(ports.emitStatus).toHaveBeenCalledWith("responding");
});

it("restores normal thinking and tool activity after a wait", () => {
  const { ports, session } = harness();
  session.onStatus("retrying in 8s");
  session.onStreamEvent({ type: "reasoning_delta", text: "thinking through the task" });
  expect(ports.emitStatus).toHaveBeenCalledWith("thinking");
  session.onToolCallDelta({ index: 0, name: "shell.exec", argumentsBytes: 5 });
  expect(ports.emitStatus).toHaveBeenCalledWith("shell.exec");
  expect(ports.notify).not.toHaveBeenCalled();
});

it("never reduces a provider notice to Free in a narrow footer", () => {
  expect(formatActivity(credentialNotice, 28)).toBe("working");
  expect(formatActivity("ℹ free/deepseek rejected reasoning options — retrying without them", 28)).toBe("working");
  expect(formatActivity("shell.exec npm test with a very long command", 28)).toBe("shell.exec");
  expect(formatActivity("thinking", 28)).toBe("thinking");
});

it("ignores empty provider status callbacks", () => {
  const { ports, session } = harness();
  session.onStatus("   ");
  expect(ports.writeStatus).not.toHaveBeenCalled();
  expect(ports.notify).not.toHaveBeenCalled();
});

it.each([
  ["retrying request in 500 ms", "retrying in 500ms"],
  ["retrying connection in 2 minutes", "retrying in 2m"],
  ["rate-limited", "rate limited"],
  ["retrying in 8s", "retry 8s"],
])("retains meaningful wait text at narrow widths: %s", (status, expected) => {
  expect(formatActivity(status, expected.length)).toBe(expected);
});

it("keeps waits through notices and empty callbacks until real progress", () => {
  vi.useFakeTimers();
  const { ports, session } = harness();
  session.onStreamEvent({ type: "reasoning_delta", text: "initial reasoning" });
  vi.mocked(ports.emitStatus).mockClear();
  session.onStatus("retrying in 20s");
  session.onStatus("Provider selected public access");
  session.onToken("");
  session.onToolCallDelta({ index: 0, argumentsBytes: 0 });
  vi.advanceTimersByTime(10_000);
  expect(ports.emitStatus).not.toHaveBeenCalled();
  session.onStreamEvent({ type: "reasoning_delta", text: "resumed reasoning" });
  expect(ports.emitStatus).toHaveBeenCalledWith("thinking");
});

it("routes provider notices through the real app adapter and shared toast pipeline", async () => {
  const services = createCompositionRoot({
    captureEvents: true,
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    agent: {
      async runTurn(_request, handlers) {
        handlers.onEvent({ type: "turn-start", prompt: "go" });
        const { ports, session } = harness();
        vi.mocked(ports.notify).mockImplementation((level, text) =>
          handlers.onEvent({ type: "notice", level, text }));
        vi.mocked(ports.writeStatus).mockImplementation(text =>
          handlers.onEvent({ type: "status", text }));
        vi.mocked(ports.emitAssistantDelta).mockImplementation(text =>
          handlers.onEvent({ type: "assistant-delta", text }));
        session.onStatus(credentialNotice);
        expect(services.toast.getToasts()).toMatchObject([{ level: "warn", message: credentialNotice }]);
        expect(services.transcript.getState().runningStatus).not.toBe(credentialNotice);
        session.onStatus("Provider selected public access");
        expect(services.toast.getToasts()).toContainEqual(expect.objectContaining({
          level: "info", message: "Provider selected public access",
        }));
        session.onStatus("⏳ free rate limited — retrying in 8s…");
        expect(services.transcript.getState().runningStatus).toBe("retrying in 8s");
        expect(services.toast.getToasts()).toHaveLength(2);
        session.onToken("OK");
        expect(services.transcript.getState().runningStatus).toBe("responding");
        session.stopHeartbeat();
        const outcome = createTurnOutcome({ status: "succeeded", answer: "OK", steps: 1, remainingCriteria: [] });
        handlers.onEvent({ type: "assistant-message", text: "OK" });
        handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "OK", steps: 1 });
        return outcome;
      },
    },
  });
  try {
    expect((await services.session.submit("go")).status).toBe("completed");
    expect(transcriptItems(services.transcript.getState()).some(item => item.kind === "notice")).toBe(false);
    const statusEvents = services.recordedEvents.filter(event => event.type === "status");
    expect(statusEvents.some(event => event.payload.text === credentialNotice)).toBe(false);
  } finally {
    services.dispose();
  }
});
