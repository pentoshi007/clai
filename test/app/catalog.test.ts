import { describe, expect, it } from "vitest";
import {
  getKnownModels,
  getSlashCommandSuggestions,
  isKnownSlashCommand,
  knownModels,
  looksLikeSlashCommand,
  slashCommandFilter,
  slashCommandLabel,
  slashCommands,
} from "../../src/app/commands/catalog.js";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";

const ALIASES = ["/use", "/search-provider", "/reasoning", "/thinking", "/quit"];

describe("W01 command catalogue lives in the app layer", () => {
  const registry = buildDefaultCommandRegistry();

  it("resolves every catalogue command through the registry", () => {
    const unresolved = slashCommands
      .map((entry) => entry.command)
      .filter((command) => !registry.has(command.slice(1)));
    expect(unresolved).toEqual([]);
  });

  it("resolves every alias to a canonical command", () => {
    for (const alias of ALIASES) {
      const resolved = registry.resolve(alias.slice(1));
      expect(resolved, alias).toBeDefined();
      expect(resolved, alias).not.toBe(alias.slice(1));
    }
  });

  it("exposes /jobs as a typed command", () => {
    expect(slashCommands.some((entry) => entry.command === "/jobs")).toBe(true);
    expect(registry.has("jobs")).toBe(true);
    expect(registry.parse("/jobs")).toEqual({
      name: "jobs",
      args: "",
      context: "global",
    });
    expect(isKnownSlashCommand("/jobs")).toBe(true);
  });

  it("treats absolute paths as prompts, not commands", () => {
    for (const line of ["/etc/hosts", "/Users/me/notes.md", "/tmp/x", "/C:\\Windows"]) {
      expect(looksLikeSlashCommand(line), line).toBe(false);
      expect(registry.parse(line), line).toBeUndefined();
      expect(registry.looksLikeCommand(line), line).toBe(false);
    }
  });

  it("keeps unique-prefix matching", () => {
    expect(registry.parse("/mod")?.name).toBe("model");
    expect(registry.parse("/imp")?.name).toBe("implement");
    expect(registry.parse("/jo")?.name).toBe("jobs");
  });

  it("carries args through a parsed invocation", () => {
    expect(registry.parse("/model kimi-k2")).toEqual({
      name: "model",
      args: "kimi-k2",
      context: "global",
    });
  });

  it("filters and labels for completion menus", () => {
    expect(slashCommandFilter("/mod")).toBe("mod");
    expect(slashCommandFilter("hello")).toBeNull();
    const suggestions = getSlashCommandSuggestions("/mod");
    expect(suggestions.map((entry) => entry.command)).toContain("/model");
    expect(slashCommandLabel(suggestions[0]!)).toContain("/mod");
  });

  it("still serves the curated model lists", () => {
    expect(Object.keys(knownModels).length).toBeGreaterThan(3);
    expect(getKnownModels("nvidia").length).toBeGreaterThan(0);
    for (const provider of Object.keys(knownModels)) {
      expect(getKnownModels(provider), provider).toEqual(knownModels[provider]);
    }
    expect(getKnownModels("no-such-provider")).toEqual([]);
  });

  it("returns a copy of the model list so callers cannot mutate the catalogue", () => {
    const first = getKnownModels("nvidia");
    first.push("mutated");
    expect(getKnownModels("nvidia")).not.toContain("mutated");
  });
});
