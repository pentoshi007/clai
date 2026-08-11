import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../../src/agent/runner.ts", import.meta.url),
);
const source = readFileSync(runnerPath, "utf8");

describe("agent runner has no presentation branch", () => {
  it("never writes to stdout", () => {
    expect(source).not.toMatch(/process\.stdout\.write/);
  });

  it("carries no writesDirectly identifier", () => {
    expect(source).not.toMatch(/\bwritesDirectly\b/);
  });

  it("imports no spinner", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*\/ui\/spinner\.js["']/);
  });
});
