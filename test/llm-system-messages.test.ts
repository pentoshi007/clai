import { describe, it, expect } from "vitest";
import { buildAnthropicBody } from "../src/llm/anthropic.js";
import {
  assertGeminiFinishReasonAllowed,
  geminiBody,
} from "../src/llm/gemini.js";
import {
  REQUEST_CONTEXT_PREFIX,
  SYSTEM_TURN_MARKER,
  normalizeSystemMessages,
  singleLeadingSystemMessages,
} from "../src/llm/system-messages.js";
import type { ChatMessage } from "../src/types.js";

/**
 * LLM-002: only the first system message used to survive on Anthropic, AWS
 * Mantle (Claude) and Gemini. Compaction memory, the live plan, engagement
 * scope, the Responder ledger and governor steering were filtered out.
 */

const history: ChatMessage[] = [
  { role: "system", content: "CONSTITUTION: you are clai." },
  { role: "user", content: "scan the host" },
  { role: "system", content: "COMPACTION MEMORY: earlier we enumerated ports." },
  { role: "assistant", content: "on it" },
  { role: "system", content: "LIVE PLAN: 1) recon 2) report" },
  { role: "system", content: "ENGAGEMENT SCOPE: 10.0.0.0/24" },
  { role: "user", content: "continue" },
  { role: "system", content: "RESPONDER LEDGER: nmap#1 ok" },
  { role: "system", content: "STEERING: stop repeating the same tool call." },
];

const laterSystems = [
  "COMPACTION MEMORY: earlier we enumerated ports.",
  "LIVE PLAN: 1) recon 2) report",
  "ENGAGEMENT SCOPE: 10.0.0.0/24",
  "RESPONDER LEDGER: nmap#1 ok",
  "STEERING: stop repeating the same tool call.",
];

describe("normalizeSystemMessages", () => {
  it("keeps the first system message as the dialect system field", () => {
    const { systemPrompt } = normalizeSystemMessages(history);
    expect(systemPrompt).toBe("CONSTITUTION: you are clai.");
  });

  it("preserves later system messages in place as marked user turns", () => {
    const { rest } = normalizeSystemMessages(history);
    expect(rest.some((m) => m.role === "system")).toBe(false);
    const marked = rest.filter((m) => m.content.startsWith(SYSTEM_TURN_MARKER));
    expect(marked).toHaveLength(laterSystems.length);
    expect(marked.every((m) => m.role === "user")).toBe(true);
    // Order relative to the surrounding turns is untouched.
    expect(rest.map((m) => m.content)).toEqual([
      "scan the host",
      `${SYSTEM_TURN_MARKER}\nCOMPACTION MEMORY: earlier we enumerated ports.`,
      "on it",
      `${SYSTEM_TURN_MARKER}\nLIVE PLAN: 1) recon 2) report`,
      `${SYSTEM_TURN_MARKER}\nENGAGEMENT SCOPE: 10.0.0.0/24`,
      "continue",
      `${SYSTEM_TURN_MARKER}\nRESPONDER LEDGER: nmap#1 ok`,
      `${SYSTEM_TURN_MARKER}\nSTEERING: stop repeating the same tool call.`,
    ]);
  });

  it("applies the marker exactly once", () => {
    const { rest } = normalizeSystemMessages([
      { role: "system", content: "first" },
      { role: "system", content: `${SYSTEM_TURN_MARKER}\nalready tagged` },
    ]);
    expect(rest[0]!.content).toBe(`${SYSTEM_TURN_MARKER}\nalready tagged`);
  });

  it("builds an immutable OpenAI-compatible list with one leading system", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "constitution" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "fs.read", args: { path: "a" } }],
      },
      { role: "tool", content: "data", toolCallId: "call-1", name: "fs.read" },
      { role: "system", content: "request context" },
      { role: "user", content: "continue" },
    ];
    const before = structuredClone(messages);
    const normalized = singleLeadingSystemMessages(messages);

    expect(normalized.filter((message) => message.role === "system")).toHaveLength(1);
    expect(normalized[0]).toEqual({ role: "system", content: "constitution" });
    expect(normalized[1]?.toolCalls?.[0]?.id).toBe("call-1");
    expect(normalized[2]).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(normalized[3]).toEqual({
      role: "user",
      content: `${SYSTEM_TURN_MARKER}\nrequest context`,
    });
    expect(messages).toEqual(before);
  });
});

describe("provider wire bodies deliver every system message", () => {
  it("anthropic", () => {
    const body = buildAnthropicBody({ messages: history }, false);
    const parsed = JSON.parse(body) as { system: string; messages: unknown[] };
    expect(parsed.system).toBe("CONSTITUTION: you are clai.");
    for (const content of laterSystems) {
      expect(body).toContain(content);
    }
    expect(JSON.stringify(parsed.messages)).toContain(SYSTEM_TURN_MARKER);
  });

  it("promotes current request context into Anthropic and Gemini system authority", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "stable constitution" },
      { role: "user", content: "prior history" },
      {
        role: "system",
        content: `${REQUEST_CONTEXT_PREFIX}\nCURRENT MODE: AGENT`,
      },
      { role: "user", content: "current request" },
    ];
    const anthropic = JSON.parse(buildAnthropicBody({ messages }, false)) as {
      system: Array<{ text: string }>;
      messages: unknown[];
    };
    expect(anthropic.system.map((part) => part.text)).toEqual([
      "stable constitution",
      `${REQUEST_CONTEXT_PREFIX}\nCURRENT MODE: AGENT`,
    ]);
    expect(JSON.stringify(anthropic.messages)).not.toContain(
      REQUEST_CONTEXT_PREFIX,
    );

    const gemini = JSON.parse(geminiBody({ messages })) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: unknown[];
    };
    expect(gemini.systemInstruction.parts.map((part) => part.text)).toEqual([
      "stable constitution",
      `${REQUEST_CONTEXT_PREFIX}\nCURRENT MODE: AGENT`,
    ]);
    expect(JSON.stringify(gemini.contents)).not.toContain(REQUEST_CONTEXT_PREFIX);
  });

  it("gemini", () => {
    const body = geminiBody({ messages: history });
    const parsed = JSON.parse(body) as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: unknown[];
    };
    expect(parsed.systemInstruction?.parts[0]?.text).toBe(
      "CONSTITUTION: you are clai.",
    );
    for (const content of laterSystems) {
      expect(JSON.stringify(parsed.contents)).toContain(content);
    }
  });
});


describe("LLM-007 — Gemini thinking budget leaves a visible reserve", () => {
  const efforts = ["low", "medium", "high", "xhigh"] as const;

  for (const effort of efforts) {
    it(`clamps thinkingBudget under maxOutputTokens for effort=${effort}`, () => {
      const body = JSON.parse(
        geminiBody({
          model: "gemini-2.5-pro",
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort },
        }),
      ) as {
        generationConfig: {
          maxOutputTokens: number;
          thinkingConfig?: { thinkingBudget?: number };
        };
      };
      const { maxOutputTokens, thinkingConfig } = body.generationConfig;
      expect(thinkingConfig?.thinkingBudget).toBeGreaterThan(0);
      expect(thinkingConfig!.thinkingBudget!).toBeLessThanOrEqual(
        Math.floor(maxOutputTokens / 2),
      );
    });
  }

  it("respects a small caller budget (compaction helper)", () => {
    const body = JSON.parse(
      geminiBody({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 2_048,
        thinking: { enabled: true, effort: "high" },
      }),
    ) as {
      generationConfig: {
        maxOutputTokens: number;
        thinkingConfig?: { thinkingBudget?: number };
      };
    };
    expect(body.generationConfig.maxOutputTokens).toBe(2_048);
    expect(body.generationConfig.thinkingConfig?.thinkingBudget).toBe(1_024);
  });

  it("leaves an explicit zero budget alone", () => {
    const body = JSON.parse(
      geminiBody({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: false },
      }),
    ) as {
      generationConfig: { thinkingConfig?: { thinkingBudget?: number } };
    };
    expect(body.generationConfig.thinkingConfig?.thinkingBudget).toBe(0);
  });
});


describe("Gemini safety settings and blocking finish reasons", () => {
  it("sends the least restrictive thresholds for all four categories", () => {
    const body = JSON.parse(
      geminiBody({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }),
    ) as { safetySettings: Array<{ category: string; threshold: string }> };
    expect(body.safetySettings).toHaveLength(4);
    expect(
      body.safetySettings.every((s) => s.threshold === "BLOCK_ONLY_HIGH"),
    ).toBe(true);
  });

  it("names a blocked response instead of reporting an empty completion", () => {
    expect(() => assertGeminiFinishReasonAllowed("SAFETY")).toThrow(/blocked/i);
    expect(() => assertGeminiFinishReasonAllowed("PROHIBITED_CONTENT")).toThrow(
      /finishReason=PROHIBITED_CONTENT/,
    );
    expect(() => assertGeminiFinishReasonAllowed("STOP")).not.toThrow();
    expect(() => assertGeminiFinishReasonAllowed(undefined)).not.toThrow();
  });
});
