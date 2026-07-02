import { describe, expect, it } from "vitest";
import { looksLikeBuildTask } from "../src/agent/runner.js";
import { looksLikePentestTask, looksLikeInformationalQuery } from "../src/agent/tool-call-parser.js";
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

describe("looksLikePentestTask", () => {
  it("detects vulnerability/vulnerabilities despite the word not ending on the bare stem", () => {
    // Regression: the stem regex (\bvulnerabilit\b) required a word boundary
    // right after "vulnerabilit", which never matches "vulnerability" or
    // "vulnerabilities" — only the nonsense fragment "vulnerabilit" itself.
    expect(
      looksLikePentestTask("perform a vulnerability assessment on example.com"),
    ).toBe(true);
    expect(
      looksLikePentestTask("scan for vulnerabilities on the target"),
    ).toBe(true);
  });

  it("detects other truncated-stem keywords (enumerate, exploit, recon)", () => {
    expect(looksLikePentestTask("enumerate subdomains for the target")).toBe(true);
    expect(looksLikePentestTask("exploit the login endpoint")).toBe(true);
    expect(looksLikePentestTask("run reconnaissance on the target")).toBe(true);
  });

  it("detects explicit pentest/security-assessment phrasing", () => {
    expect(looksLikePentestTask("do a pentest on 10.0.0.1")).toBe(true);
    expect(looksLikePentestTask("run a security assessment on aniketpandey.website")).toBe(true);
    expect(looksLikePentestTask("check for xss and sqli")).toBe(true);
  });

  it("does not flag unrelated prompts", () => {
    expect(looksLikePentestTask("what is the latest iPhone price")).toBe(false);
    expect(looksLikePentestTask("build a react app now")).toBe(false);
  });
});

describe("looksLikeInformationalQuery", () => {
  it("treats plain follow-up questions as informational, not work requests", () => {
    // Regression: "what do u know till now" in a resumed pentest session
    // was treated as "must act" and forced explore→plan, creating a brand-new
    // unrelated plan instead of answering from context.
    expect(looksLikeInformationalQuery("what do u know till now")).toBe(true);
    expect(looksLikeInformationalQuery("what did you find")).toBe(true);
    expect(looksLikeInformationalQuery("summarize the results")).toBe(true);
    expect(looksLikeInformationalQuery("tell me what you learned")).toBe(true);
  });

  it("treats explicit build/continuation phrasing as NOT informational", () => {
    // Even when they open with a question word, these are work requests.
    expect(looksLikeInformationalQuery("can you build the api")).toBe(false);
    expect(looksLikeInformationalQuery("should I add auth")).toBe(false);
    expect(looksLikeInformationalQuery("finish it")).toBe(false);
    expect(looksLikeInformationalQuery("do it")).toBe(false);
  });

  it("treats informational signals as informational even without a question mark", () => {
    expect(looksLikeInformationalQuery("compare react and vue")).toBe(true);
    expect(looksLikeInformationalQuery("explain the security headers")).toBe(true);
    expect(looksLikeInformationalQuery("overview of the findings")).toBe(true);
  });
});
