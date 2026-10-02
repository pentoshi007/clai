import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { autoCompactTriggerTokens } from "../../src/agent/request-budget.js";
import { resetRequestTokenCalibration } from "../../src/llm/token-estimate-calibration.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../../src/types.js";

const stream = vi.fn<
  (request: CompletionRequest, onToken: (text: string) => void) => Promise<CompletionResult>
>();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (request: CompletionRequest, onToken: (text: string) => void) =>
      stream(request, onToken),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

const PROVIDER = "nvidia" as const;
const MODEL = "test-model";
const LIMIT = 200_000;
const PROMPT = "done, make sure readme is up to date";
const STALE_SUMMARY = [
  "## Work completed",
  "The release was prepared and existing checks passed.",
  "## Remaining work",
  "Finish the old release task.",
].join("\n");
const trigger = autoCompactTriggerTokens({
  provider: PROVIDER,
  model: MODEL,
  contextLimitTokens: LIMIT,
});

function history(): ChatMessage[] {
  return [
    { role: "user", content: "publish the release" },
    { role: "assistant", content: "release evidence ".repeat(35_000) },
    { role: "user", content: "verify the checks" },
    { role: "assistant", content: "The old release checks passed." },
  ];
}

async function submit(prompt: string, measuredTokens?: number) {
  const events: AgentEvent[] = [];
  let messages: ChatMessage[] = [];
  await runAgentTurn(prompt, {
    session: createSessionPolicy(),
    provider: PROVIDER,
    model: MODEL,
    history: history(),
    maxSteps: 2,
    contextLimitTokens: LIMIT,
    ...(measuredTokens !== undefined ? { providerReportedContextTokens: measuredTokens } : {}),
    onEvent: (event) => events.push(event),
    onMessages: (next) => { messages = next; },
  });
  const generation = stream.mock.calls.find(([request]) => request.purpose !== "compaction")?.[0];
  return { events, messages, generation };
}

beforeEach(() => {
  stream.mockReset();
  resetRequestTokenCalibration({ removePersisted: true });
  stream.mockImplementation(async (request, onToken) => {
    const text = request.purpose === "compaction" ? STALE_SUMMARY : "README reviewed.";
    onToken(text);
    return { text, provider: PROVIDER, model: MODEL };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submission at the automatic compaction boundary", () => {
  it("dispatches a small new prompt below the trigger without compacting first", async () => {
    const result = await submit(PROMPT, trigger - 5_000);

    expect(result.events.filter((event) => event.type === "compaction-start")).toHaveLength(0);
    expect(result.generation?.messages.some((message) => message.role === "user" && message.content === PROMPT)).toBe(true);
  });

  it("counts a large incoming prompt before the first model dispatch", async () => {
    const prompt = `${PROMPT}\n${"new user instructions ".repeat(4_000)}`;
    const result = await submit(prompt, trigger - 5_000);

    expect(result.events.filter((event) => event.type === "compaction-completed")).toHaveLength(1);
    expect(stream.mock.calls[0]?.[0].purpose).toBe("compaction");
    expect(result.generation?.messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "user" && message.content === prompt)).toBe(true);
  });

  it("retains the current request when previous provider usage already crossed the trigger", async () => {
    const result = await submit(PROMPT, trigger + 1_000);

    expect(result.events.filter((event) => event.type === "compaction-completed")).toHaveLength(1);
    expect(result.generation?.messages.filter((message) => message.role === "user" && message.content === PROMPT)).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "user" && message.content === PROMPT)).toBe(true);
  });

  it("checks the current assembled request even without provider usage", async () => {
    const prompt = `${PROMPT}\n${"new user instructions ".repeat(4_000)}`;
    const result = await submit(prompt);

    expect(result.events.filter((event) => event.type === "compaction-completed")).toHaveLength(1);
    expect(result.generation?.messages.some((message) => message.role === "user" && message.content === prompt)).toBe(true);
  });
});
