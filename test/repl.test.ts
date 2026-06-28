import { describe, expect, it } from "vitest";
import {
  getKnownModels,
  getSlashCommandSuggestions,
  isKnownSlashCommand,
  renderSlashCommandMenu,
} from "../src/repl.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("REPL slash command suggestions", () => {
  it("lists commands after a bare slash", () => {
    // A bare '/' should trigger suggestions so user can see available commands immediately.
    const bareSlashCommands = getSlashCommandSuggestions("/").map(
      (item) => item.command,
    );
    expect(bareSlashCommands).toContain("/ask");
    expect(bareSlashCommands).toContain("/agent");
    expect(bareSlashCommands).toContain("/model");

    // With one character, suggestions should also appear.
    const commands = getSlashCommandSuggestions("/a").map(
      (item) => item.command,
    );
    expect(commands).toContain("/ask");
    expect(commands).toContain("/agent");
  });
  it("filters commands by typed prefix", () => {
    const commands = getSlashCommandSuggestions("/m").map(
      (item) => item.command,
    );

    expect(commands).toEqual(["/model", "/mouse"]);
  });

  it("stops suggesting after command arguments begin", () => {
    expect(getSlashCommandSuggestions("/model ")).toEqual([]);
  });

  it("distinguishes real slash commands from absolute dropped paths", () => {
    expect(isKnownSlashCommand("/variants high")).toBe(true);
    expect(isKnownSlashCommand("/var/folders/screenshot.png what is it")).toBe(false);
  });

  it("renders slash menu rows within terminal width so refresh can redraw in-place", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      value: 80,
    });
    try {
      const suggestions = getSlashCommandSuggestions("/p");
      const rows = renderSlashCommandMenu("/p", suggestions, 0);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(stripAnsi(row).length).toBeLessThanOrEqual(79);
      }
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: originalColumns,
      });
    }
  });
});

describe("REPL known model lists", () => {
  it("does not offer decommissioned Groq models", () => {
    const models = getKnownModels("groq");
    expect(models).not.toContain("gemma2-9b-it");
    expect(models).not.toContain("moonshotai/kimi-k2-instruct");
    expect(models).not.toContain("deepseek-r1-distill-llama-70b");
    expect(models).toContain("qwen/qwen3-32b");
  });

  it("exposes the documented NVIDIA NIM models with the new gpt-oss default at the top", () => {
    const models = getKnownModels("nvidia");
    expect(models[0]).toBe("openai/gpt-oss-20b");
    expect(models).toContain("moonshotai/kimi-k2.6");
    expect(models).toContain("deepseek-ai/deepseek-v4-flash");
    expect(models).toContain("deepseek-ai/deepseek-v4-pro");
    expect(models).toContain("z-ai/glm-5.1");
    expect(models).toContain("mistralai/mistral-medium-3.5-128b");
    expect(models).toContain("google/gemma-4-31b-it");
  });

  it("exposes only the documented AgentRouter models (5 listed in provider docs)", () => {
    const models = getKnownModels("agentrouter");
    expect(models).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "glm-5.2",
      "gpt-5.5",
    ]);
  });
});
