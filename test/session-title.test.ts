import { describe, expect, it } from "vitest";
import { MAX_TITLE_CHARS, sanitizeTitle } from "../src/agent/session-title.js";

describe("sanitizeTitle reasoning stripping", () => {
  it("allows a readable multi-task title longer than the old limit", () => {
    const title = "Authentication, Billing, Deployment, Session Naming and Subagent Recovery";
    expect(title.length).toBeGreaterThan(64);
    expect(sanitizeTitle(title)).toBe(title);
  });

  it("bounds oversized titles without splitting a trailing word", () => {
    const title = sanitizeTitle("Authentication billing deployment recovery testing ".repeat(5))!;
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(title).toMatch(/(?:Authentication|billing|deployment|recovery|testing)…$/);
  });

  it("does not split a surrogate pair when truncating Unicode titles", () => {
    const title = sanitizeTitle("🚀".repeat(120))!;
    expect(Array.from(title)).toHaveLength(MAX_TITLE_CHARS);
    expect(title).toBe(`${"🚀".repeat(MAX_TITLE_CHARS - 1)}…`);
  });

  it("strips <think> reasoning before the title", () => {
    expect(sanitizeTitle("<think>let me name this</think>Fix login bug")).toBe(
      "Fix login bug",
    );
  });

  it("strips Kimi's <thinking> reasoning before the title", () => {
    expect(
      sanitizeTitle("<thinking>pick a concise title</thinking>Refactor parser"),
    ).toBe("Refactor parser");
  });

  it("drops an unclosed <thinking> block that swallows the answer", () => {
    expect(sanitizeTitle("<thinking>still reasoning with no close")).toBeUndefined();
  });
});
