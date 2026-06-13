import { describe, expect, it } from "vitest";
import { looksLikeBuildTask } from "../src/agent/runner.js";
import type { ChatMessage } from "../src/types.js";

describe("looksLikeBuildTask", () => {
  it("detects explicit build/scaffold prompts", () => {
    expect(looksLikeBuildTask("create a simple blogging app in react here")).toBe(
      true,
    );
    expect(looksLikeBuildTask("build an express api with auth")).toBe(true);
    expect(looksLikeBuildTask("scaffold a next.js project")).toBe(true);
  });

  it("detects framework/stack mentions even without a build verb", () => {
    expect(looksLikeBuildTask("set up tailwind and redux")).toBe(true);
    expect(looksLikeBuildTask("a vite + react frontend")).toBe(true);
  });

  it("treats terse continuation prompts as build work", () => {
    expect(looksLikeBuildTask("do it")).toBe(true);
    expect(looksLikeBuildTask("build fully on your own")).toBe(true);
    expect(looksLikeBuildTask("continue")).toBe(true);
    expect(looksLikeBuildTask("finish it")).toBe(true);
  });

  it("treats 'app is not complete' style nudges as build work", () => {
    expect(looksLikeBuildTask("app is not complete")).toBe(true);
    expect(looksLikeBuildTask("the project isn't done")).toBe(true);
  });

  it("inherits build context from recent history for a terse follow-up", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "create a simple blogging app in react here" },
      { role: "assistant", content: "Here is the plan ..." },
    ];
    expect(looksLikeBuildTask("read directory and see what you built", history)).toBe(
      true,
    );
  });

  it("treats the /implement plan-execution message as build work", () => {
    const implementMsg =
      "I approve the plan. Execute it now, task by task: mark each task in_progress before " +
      "you start it and done after it actually succeeds.";
    expect(looksLikeBuildTask(implementMsg)).toBe(true);
  });

  it("does not flag unrelated one-shot lookups", () => {
    expect(looksLikeBuildTask("who registered example.com")).toBe(false);
    expect(looksLikeBuildTask("what is my ip")).toBe(false);
    expect(looksLikeBuildTask("scan port 80 on 10.0.0.1")).toBe(false);
  });

  it("does not flag informational questions that merely mention a stack", () => {
    expect(
      looksLikeBuildTask(
        "compare their installation and integration steps in react vite",
      ),
    ).toBe(false);
    expect(
      looksLikeBuildTask("what are the differences between tailwind 3 and 4"),
    ).toBe(false);
    expect(looksLikeBuildTask("how do I install tailwind in vite")).toBe(false);
    expect(looksLikeBuildTask("react vs vue for a dashboard?")).toBe(false);
    expect(looksLikeBuildTask("explain how vite handles HMR")).toBe(false);
  });

  it("does not inherit build from the agent's own plan narration", () => {
    // The user only asked an informational question; the assistant then
    // (mistakenly) drafted a build plan. A follow-up must NOT be treated as a
    // build just because the assistant's plan text mentions a stack.
    const history: ChatMessage[] = [
      {
        role: "user",
        content: "compare installation steps in react vite",
      },
      {
        role: "assistant",
        content: "Plan: 1. Initialize a new Vite React app 2. Install Tailwind",
      },
    ];
    expect(looksLikeBuildTask("you just have to tell me, do not write anything", history)).toBe(
      false,
    );
  });
});
