import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../../src/agent/runner.ts", import.meta.url),
);
const source = readFileSync(runnerPath, "utf8");

describe("agent runner has no direct process output", () => {
  it("never writes to process stdout or stderr", () => {
    expect(source).not.toMatch(/process\.stdout\.write/);
    expect(source).not.toMatch(/process\.stderr\.write/);
  });

  it("keeps the legacy direct-write branch removed", () => {
    expect(source).not.toMatch(/\bwritesDirectly\b/);
  });

  it("imports no spinner", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*\/ui\/spinner\.js["']/);
  });
});
