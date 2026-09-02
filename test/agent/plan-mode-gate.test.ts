import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/types.js";
import {
  decidePlanModeGate,
  PLAN_MODE_BLOCK_SUFFIX,
} from "../../src/agent/turn/plan-mode-gate.js";

const gate = (call: ToolCall, overrides: Record<string, unknown> = {}) =>
  decidePlanModeGate({
    call,
    isPlanMode: true,
    planApproved: false,
    scratchDir: "/tmp/scratch",
    mcpSafe: false,
    ...overrides,
  });

describe("plan mode gate", () => {
  it("allows everything outside plan mode", () => {
    expect(
      gate({ name: "fs.write", args: { path: "/app/a.ts" } }, { isPlanMode: false }),
    ).toEqual({ blocked: false });
  });

  it("allows everything once the plan is approved", () => {
    expect(
      gate({ name: "fs.write", args: { path: "/app/a.ts" } }, { planApproved: true }),
    ).toEqual({ blocked: false });
  });

  it("blocks project writes while a draft awaits approval", () => {
    const decision = gate({ name: "fs.write", args: { path: "/app/a.ts" } });
    expect(decision.blocked).toBe(true);
    expect(decision).toMatchObject({
      reason: `plan mode — fs.write ${PLAN_MODE_BLOCK_SUFFIX}`,
    });
  });

  it("allows a scratch-only write", () => {
    expect(
      gate({ name: "fs.write", args: { path: "/tmp/scratch/notes.md" } }),
    ).toEqual({ blocked: false });
  });

  it("allows read-only recon tools", () => {
    expect(gate({ name: "fs.read", args: { path: "/app/a.ts" } })).toEqual({
      blocked: false,
    });
    expect(gate({ name: "dns.lookup", args: { host: "example.com" } })).toEqual({
      blocked: false,
    });
  });

  it("allows an mcp tool the runtime classifies as safe", () => {
    expect(
      gate({ name: "mcp.docs.search", args: {} }, { mcpSafe: true }),
    ).toEqual({ blocked: false });
  });

  it("always blocks interactive terminal control", () => {
    expect(gate({ name: "terminal.start", args: {} }).blocked).toBe(true);
    expect(gate({ name: "terminal.send", args: { text: "ls" } }).blocked).toBe(
      true,
    );
  });

  it("permits read-only shell commands and blocks mutating ones", () => {
    expect(gate({ name: "shell.exec", args: { command: "ls -la" } })).toEqual({
      blocked: false,
    });
    expect(
      gate({
        name: "shell.exec",
        args: { command: "npm create vite@latest app" },
      }).blocked,
    ).toBe(true);
    expect(
      gate({
        name: "shell.start",
        args: { command: "npx create-next-app app" },
      }).blocked,
    ).toBe(true);
  });

  it("blocks a shell call with no command string", () => {
    expect(gate({ name: "shell.exec", args: {} }).blocked).toBe(true);
  });
});
