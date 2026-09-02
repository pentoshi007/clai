import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runnerPath = fileURLToPath(
  new URL("../../src/agent/runner.ts", import.meta.url),
);
const source = readFileSync(runnerPath, "utf8");
const directProcessWritePattern = /process\.(?:stdout|stderr)\.write/;

function hasDirectProcessWrite(value: string): boolean {
  return directProcessWritePattern.test(value);
}

describe("agent runner has no direct process output", () => {
  it("never writes to process stdout or stderr", () => {
    expect(hasDirectProcessWrite(source)).toBe(false);
  });

  it("detects synthetic direct process writes", () => {
    expect(hasDirectProcessWrite('process.stdout.write("out")')).toBe(true);
    expect(hasDirectProcessWrite('process.stderr.write("err")')).toBe(true);
  });

  it("keeps the legacy direct-write branch removed", () => {
    expect(source).not.toMatch(/\bwritesDirectly\b/);
  });

  it("imports no spinner", () => {
    expect(source).not.toMatch(/from\s+["'][^"']*\/ui\/spinner\.js["']/);
  });
});
