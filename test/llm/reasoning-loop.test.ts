import { describe, expect, it } from "vitest";
import { REASONING_LOOP_WINDOW_CHARS, ReasoningLoopGuard } from "../../src/llm/wire/reasoning-loop.js";

describe("ReasoningLoopGuard", () => {
  it("requires a full window before declaring repetition", () => {
    const guard = new ReasoningLoopGuard();
    expect(guard.append("h".repeat(REASONING_LOOP_WINDOW_CHARS - 1))).toBe(false);
    expect(guard.append("h")).toBe(true);
  });

  it.each([" ", "\n", "hmm ", "0xdeadbeef ", "嗯……"])("detects %j independently of delta boundaries", (pattern) => {
    const guard = new ReasoningLoopGuard();
    const text = pattern.repeat(REASONING_LOOP_WINDOW_CHARS);
    let detected = false;
    for (let offset = 0; offset < REASONING_LOOP_WINDOW_CHARS + 130; offset += 13) {
      detected ||= guard.append(text.slice(offset, offset + 13));
    }
    expect(detected).toBe(true);
  });

  it("accepts short repetition and clears it on output progress", () => {
    const guard = new ReasoningLoopGuard();
    expect(guard.append("hmm ".repeat(600))).toBe(false);
    guard.reset();
    expect(guard.append("hmm ".repeat(600))).toBe(false);
  });

  it("does not mistake repeated natural language with evolving details for a loop", () => {
    const guard = new ReasoningLoopGuard();
    for (let index = 0; index < 1_000; index += 1) {
      expect(guard.append(`Evaluate candidate ${index}, compare its result, then consider the next option.\n`)).toBe(false);
    }
  });

  it("finds a loop after a long nonperiodic prefix", () => {
    const guard = new ReasoningLoopGuard();
    expect(guard.append(Array.from({ length: 500 }, (_, index) => `Step ${index}: examine evidence.\n`).join(""))).toBe(false);
    expect(guard.append("hmm ".repeat(REASONING_LOOP_WINDOW_CHARS))).toBe(true);
  });

  it("requires at least 32 repetitions of the same short sequence", () => {
    const pattern = Array.from({ length: 48 }, (_, index) => `${index},`).join("");
    const guard = new ReasoningLoopGuard();
    expect(pattern.length).toBeGreaterThan(REASONING_LOOP_WINDOW_CHARS / 32);
    expect(guard.append(pattern.repeat(40))).toBe(false);
  });
});
