import { describe, expect, it, vi } from "vitest";
import {
  CommandRegistry,
  buildDefaultCommandRegistry,
} from "../../src/app/commands/registry.js";
import { slashCommands } from "../../src/app/commands/catalog.js";

describe("V2-024 command registry", () => {
  it("covers every legacy slash command exactly once (via canonical or alias)", () => {
    const registry = buildDefaultCommandRegistry();
    for (const command of slashCommands) {
      expect(registry.has(command.command)).toBe(true);
    }
  });

  it("describes the complete MCP project and selection workflow", () => {
    const mcp = slashCommands.find((entry) => entry.command === "/mcp");
    expect(mcp?.usage).toContain("add");
    expect(mcp?.usage).toContain("locations");
    expect(mcp?.usage).toContain("refresh");
    expect(mcp?.usage).toContain("login");
    expect(mcp?.usage).toContain("reconnect");
    expect(mcp?.usage).toContain("tools");
    expect(mcp?.usage).toContain("status");
    // for commands with enumerated options, description is kept minimal (single-line use-case)
    expect(mcp?.description.length).toBeLessThan(60);
  });

  it("resolves aliases to their canonical command", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.resolve("/use")).toBeUndefined();
    expect(registry.resolve("/search-provider")).toBe("search");
    expect(registry.resolve("/reasoning")).toBe("effort");
    expect(registry.resolve("/legacy-effort")).toBeUndefined();
    expect(registry.resolve("/thinking")).toBe("think");
    expect(registry.resolve("/quit")).toBe("exit");
    expect(registry.resolve("/model")).toBe("model");
    expect(registry.resolve("/nope")).toBeUndefined();
  });

  it("does not list aliases as separate top-level commands", () => {
    const registry = buildDefaultCommandRegistry();
    const names = registry.all().map((d) => d.name);
    expect(names).not.toContain("use");
    expect(names).not.toContain("quit");
    expect(names).toContain("provider");
    expect(names).toContain("exit");
  });

  it("parses a slash line into a resolved invocation", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.parse("/search-provider tavily")).toEqual({
      name: "search",
      args: "tavily",
      context: "global",
    });
    expect(registry.parse("/use nvidia")).toBeUndefined();
    expect(registry.parse("/model")).toEqual({
      name: "model",
      args: "",
      context: "global",
    });
    expect(registry.parse("not a command")).toBeUndefined();
  });

  it("dispatches to a handler registered on the canonical name via an alias", async () => {
    const registry = buildDefaultCommandRegistry();
    const handler = vi.fn();
    registry.setHandler("search", handler);
    const handled = await registry.dispatch({ name: "search-provider", args: "tavily" });
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      name: "search",
      args: "tavily",
      context: "global",
    });
  });

  it("returns false when dispatching an unknown or handler-less command", async () => {
    const registry = buildDefaultCommandRegistry();
    expect(await registry.dispatch({ name: "does-not-exist" })).toBe(false);
    expect(await registry.dispatch({ name: "model" })).toBe(false);
  });

  it("suggests commands by prefix over names and aliases", () => {
    const registry = buildDefaultCommandRegistry();
    const us = registry.suggestions("us").map((d) => d.name);
    expect(us).toContain("usage");
    expect(us).not.toContain("provider");
    expect(registry.parse("/us")).toMatchObject({ name: "usage" });
    const model = registry.suggestions("mod").map((d) => d.name);
    expect(model).toContain("model");
  });

  it("rejects duplicate command names and aliases", () => {
    const registry = new CommandRegistry();
    registry.register({ name: "foo", description: "x", aliases: ["f"] });
    expect(() => registry.register({ name: "foo", description: "y" })).toThrow();
    expect(() =>
      registry.register({ name: "bar", description: "z", aliases: ["f"] }),
    ).toThrow();
  });
});

describe("command input normalization", () => {
  const registry = buildDefaultCommandRegistry({ pathExists: (path) => path === "/tmp" || path === "/etc" });

  it("dispatches commands preceded by invisible format characters", () => {
    for (const prefix of ["\u200b", "\u2060", "\ufeff", "\u200e", "\u00ad", "\u200b \u200d"]) {
      const line = `${prefix}/model kimi-k2`;
      expect(registry.looksLikeCommand(line), JSON.stringify(line)).toBe(true);
      expect(registry.parse(line), JSON.stringify(line)).toEqual({ name: "model", args: "kimi-k2", context: "global" });
    }
    expect(registry.parse("/mo\u200bdel")?.name).toBe("model");
  });

  it("accepts IME slash look-alikes only for registered commands", () => {
    for (const slash of ["\uff0f", "\u2215", "\u2044", "\u29f8"]) {
      expect(registry.parse(`${slash}model gpt`), slash).toEqual({ name: "model", args: "gpt", context: "global" });
      expect(registry.looksLikeCommand(`${slash}hel`), slash).toBe(true);
      expect(registry.looksLikeCommand(`${slash}zzz`), slash).toBe(false);
      expect(registry.parse(`${slash}zzz`), slash).toBeUndefined();
    }
  });

  it("keeps existing filesystem roots and nested paths as prompts", () => {
    for (const line of ["/tmp", "/etc explain this directory", "/usr/var/etc.txt", "/Users/me/notes.md", "\u200b/usr/bin/env"]) {
      expect(registry.looksLikeCommand(line), line).toBe(false);
      expect(registry.parse(line), line).toBeUndefined();
    }
  });

  it("still reports unknown command-shaped input that is not an existing path", () => {
    expect(registry.looksLikeCommand("/not-a-real-command")).toBe(true);
    expect(registry.parse("/not-a-real-command")).toBeUndefined();
  });
});
