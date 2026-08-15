import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeAgentSystemPrompt } from "../src/agent/prompt-composer.js";
import {
  createTurnOutcome,
  normalizeTurnOutcomeInput,
  renderTurnOutcome,
} from "../src/agent/turn-outcome.js";
import { compactMessagesWithSummary } from "../src/agent/context-manager.js";
import { hasOrphanToolMessages } from "../src/agent/tool-history.js";
import { createPlan, isPlanSuccessful, isPlanTerminal, markTask } from "../src/store/plan.js";
import { resolveTurnInput, shouldRunImageOcr } from "../src/attachments/service.js";
import { isPentestToolCall } from "../src/safety/classifier.js";
import type { ChatMessage } from "../src/types.js";

describe("God Mode Phase 1 contracts", () => {
  it.each(["ask", "plan", "agent"] as const)(
    "composes mandatory dynamic context on every %s round",
    (mode) => {
      const prompt = composeAgentSystemPrompt({
        mode,
        nativeToolsActive: true,
        maxTokens: 80,
        sections: [
          { kind: "constitution", content: "SAFETY CONSTITUTION", mandatory: true },
          { kind: "outcome", content: "OUTCOME: criterion-1 remains", mandatory: true },
          { kind: "plan", content: "ACTIVE PLAN: t1", mandatory: true },
          { kind: "scope", content: "ENGAGEMENT SCOPE: exclude bad.example", mandatory: true },
          { kind: "context", content: "x".repeat(2_000) },
        ],
      });
      expect(prompt.content).toContain(`CURRENT MODE: ${mode.toUpperCase()}`);
      expect(prompt.content).toContain("OUTCOME: criterion-1 remains");
      expect(prompt.content).toContain("ACTIVE PLAN: t1");
      expect(prompt.content).toContain("ENGAGEMENT SCOPE");
      expect(prompt.omitted).toContain("context");
    },
  );

  it("distinguishes terminal plans from successful plans", () => {
    const plan = createPlan({ sessionId: "phase1", goal: "ship", detail: "", taskTitles: ["build", "verify"] });
    markTask(plan, "t1", "done");
    markTask(plan, "t2", "failed");
    expect(isPlanTerminal(plan)).toBe(true);
    expect(isPlanSuccessful(plan)).toBe(false);
  });

  it("returns the answer without a diagnostics footer for failed turns", () => {
    const outcome = createTurnOutcome({
      status: "failed",
      answer: "Implementation stopped.",
      steps: 3,
      remainingCriteria: ["verify behavior"],
      reason: "required task failed",
    });
    expect(renderTurnOutcome(outcome)).toBe("Implementation stopped.");
    expect(renderTurnOutcome(outcome)).not.toContain("Status:");
    expect(renderTurnOutcome(outcome)).not.toContain("Remaining:");
  });

  it("normalizes a success signal with unfinished criteria before enforcing the invariant", () => {
    const normalized = normalizeTurnOutcomeInput({
      status: "succeeded",
      answer: "Work stopped before verification.",
      steps: 2,
      remainingCriteria: ["verify behavior"],
    });
    const outcome = createTurnOutcome(normalized);
    expect(outcome.status).toBe("partial");
    expect(outcome.remainingCriteria).toEqual(["verify behavior"]);
    expect(outcome.reason).toMatch(/remain incomplete/i);
  });

  it("keeps structured partial state without appending diagnostics to conversational answers", () => {
    const outcome = createTurnOutcome({
      status: "partial",
      answer: "Yes — I can help with an authorized assessment.",
      steps: 0,
      remainingCriteria: ["Authorized assessment completed"],
      reason: "no target was provided",
    });
    expect(renderTurnOutcome(outcome, { diagnostics: false })).toBe(
      "Yes — I can help with an authorized assessment.",
    );
    expect(renderTurnOutcome(outcome)).toBe(
      "Yes — I can help with an authorized assessment.",
    );
    expect(renderTurnOutcome(outcome)).not.toContain("Status:");
  });

  it("keeps native assistant/tool-result groups atomic during semantic compaction", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "fs.read", args: { path: "x" } }] },
      { role: "tool", content: "result", toolCallId: "call-1", name: "fs.read" },
      { role: "user", content: "latest" },
    ];
    const compacted = await compactMessagesWithSummary(messages, async () => "summary", { budgetTokens: 0, keepRecent: 2 });
    expect(hasOrphanToolMessages(compacted.messages)).toBe(false);
  });

  it("delivers exact image bytes and MIME through shared turn resolution", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-phase1-"));
    const image = join(dir, "pixel.png");
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(image, bytes);
    const resolved = resolveTurnInput({
      prompt: `inspect @${image}`,
      mode: "plan",
      provider: "openai",
      model: "gpt-4o",
      baseDir: dir,
    });
    expect(resolved.mode).toBe("plan");
    expect(resolved.images[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(resolved.images[0]?.dataBase64 ?? "", "base64")).toEqual(bytes);
  });

  it("never runs mandatory OCR when vision bytes can be sent", () => {
    expect(
      shouldRunImageOcr({
        hasImage: true,
        visionCapable: true,
        prompt: "OCR the text in this screenshot",
      }),
    ).toBe(false);
    expect(
      shouldRunImageOcr({
        hasImage: true,
        visionCapable: false,
        prompt: "describe the colors and spacing",
      }),
    ).toBe(false);
    expect(
      shouldRunImageOcr({
        hasImage: true,
        visionCapable: false,
        prompt: "extract the text from this screenshot",
      }),
    ).toBe(true);
  });

  it("classifies scanner processes and active HTTP while excluding passive requests", () => {
    expect(
      isPentestToolCall({
        name: "shell.start",
        args: { command: "nmap -sV example.com" },
      }),
    ).toBe(true);
    expect(
      isPentestToolCall({
        name: "http.fetch",
        args: { url: "https://example.com/admin", method: "POST" },
      }),
    ).toBe(true);
    expect(
      isPentestToolCall({
        name: "http.fetch",
        args: { url: "https://example.com/", method: "GET" },
      }),
    ).toBe(false);
    expect(
      isPentestToolCall({
        name: "shell.start",
        args: { command: "npm run dev" },
      }),
    ).toBe(false);
  });

  it("rejects succeeded outcomes that still have unmet criteria", () => {
    expect(() =>
      createTurnOutcome({
        status: "succeeded",
        answer: "done",
        steps: 1,
        remainingCriteria: ["verify"],
      }),
    ).toThrow(/succeeded turn/);
  });
});
