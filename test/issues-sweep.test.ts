import { describe, expect, it } from "vitest";
import { classifyToolCall } from "../src/safety/classifier.js";
import { availableToolNames } from "../src/tools/registry.js";
import { renderAgentSystemPrompt } from "../src/prompts/index.js";
import { isCtrlO } from "../src/ui/keys.js";

/**
 * issues.md §23 + Recommended Architecture upgrades — quick acceptance
 * sweep so the regressions list stays green without scattering across
 * many files.
 */

describe("issues.md §23 — sweep", () => {
  it("cat ~/.clai/keys.json is blocked, not auto-safe", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "cat ~/.clai/keys.json" },
      }).level,
    ).toBe("block");
  });

  it("env / printenv auto-run (read-only env inspection is not mutating)", () => {
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "env" } }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "printenv" } })
        .level,
    ).toBe("safe");
  });

  it("http.fetch POST/PUT/PATCH/DELETE auto-run as network requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const decision = classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method },
      });
      expect(decision.level).toBe("safe");
    }
  });

  it("public scan with --i-own-this auto-runs like other scanner commands", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "nmap --i-own-this 8.8.8.8" },
    });
    expect(decision.level).toBe("safe");
  });

  it("Ctrl+O uses the same readline shape on macOS, Linux, Windows", () => {
    // readline normalizes the keypress into { ctrl, name } across platforms,
    // so we don't need to maintain platform-specific sequences.
    expect(isCtrlO({ ctrl: true, name: "o" })).toBe(true);
    expect(isCtrlO({ ctrl: false, name: "o" })).toBe(false);
    expect(isCtrlO({ ctrl: true, name: "p" })).toBe(false);
  });

  it("the agent prompt advertises tool.batch alongside other tools", () => {
    const prompt = renderAgentSystemPrompt(availableToolNames().join(", "));
    expect(prompt).toMatch(/tool\.batch/);
    expect(prompt).toMatch(/in parallel/);
  });

  it("availableToolNames includes tool.batch", () => {
    expect(availableToolNames()).toContain("tool.batch");
  });
});
