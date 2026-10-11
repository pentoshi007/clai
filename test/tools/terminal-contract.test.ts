import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TOOL_DEFINITIONS_TERMINAL } from "../../src/tools/definitions/terminal.js";
import { INTERACTIVE_SESSION_DEFAULTS, INTERACTIVE_SESSION_RANGES, type RangedConfigField } from "../../src/interactive-session/config.js";

function property(name: string, key: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS_TERMINAL.find(tool => tool.name === name);
  const properties = definition?.parameters.properties as Record<string, Record<string, unknown>>;
  return properties[key]!;
}

describe("terminal model contract", () => {
  it.each([
    ["terminal.start", "deadlineMs", "startDeadlineMs"],
    ["terminal.start", "idleTimeoutMs", "idleTimeoutMs"],
    ["terminal.start", "lifetimeTimeoutMs", "lifetimeTimeoutMs"],
    ["terminal.send", "deadlineMs", "sendDeadlineMs"],
    ["terminal.send", "quietMs", "quietIntervalMs"],
    ["terminal.close", "deadlineMs", "closeDeadlineMs"],
  ] as const)("publishes the real runtime bounds/default for %s.%s", (tool, key, field: RangedConfigField) => {
    const schema = property(tool, key);
    expect(schema.minimum).toBe(INTERACTIVE_SESSION_RANGES[field].min);
    expect(schema.maximum).toBe(INTERACTIVE_SESSION_RANGES[field].max);
    expect(schema.default).toBe(INTERACTIVE_SESSION_DEFAULTS[field]);
    expect(typeof schema.description).toBe("string");
  });

  it("documents startup versus lifetime and byte-cursor semantics", () => {
    expect(property("terminal.start", "deadlineMs").description).toMatch(/launch only.*never session lifetime/i);
    expect(property("terminal.read", "cursor").description).toMatch(/redacted byte cursor/i);
    expect(property("terminal.read", "waitMs").maximum).toBe(30_000);
    expect(property("terminal.start", "columns").minimum).toBe(2);
    expect(property("terminal.send", "submit").default).toBe("enter");
    expect(property("terminal.send", "view").description).toMatch(/each event as base64/i);
  });

  it("keeps prompt guidance synchronized with the secret flow and timeout recovery", () => {
    const prompt = readFileSync(new URL("../../src/prompts/system.agent.md", import.meta.url), "utf8");
    expect(prompt).toContain("<text|secret|control|eof>");
    expect(prompt).toContain("NOT session lifetime");
    expect(prompt).toContain("earliestAvailableCursor");
    expect(prompt).toContain("ssh -v is verbose login, not a version probe");
    expect(prompt).toContain("Quiet means output paused, NOT command finished");
    expect(prompt).toContain("A session that exits before secret delivery does NOT prove the password was wrong");
  });
});
