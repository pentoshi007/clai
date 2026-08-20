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
