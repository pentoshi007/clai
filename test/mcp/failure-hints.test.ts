import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manageRea } from "../../src/rea/runtime.js";
import { REA_SERVER } from "../../src/rea/workflow.js";
import { reaTestRuntime, resetRea, seedRea } from "../helpers/rea-runtime.js";

const TOOLS = [
  { name: "strict_tool", description: "Strict", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
  { name: "fine_tool", description: "Fine", inputSchema: { type: "object", properties: {} } },
];

let root: string;
let host: ReturnType<typeof reaTestRuntime>;

beforeEach(async () => {
  resetRea();
  root = mkdtempSync(join(tmpdir(), "clai-mcp-hints-"));
  host = reaTestRuntime(root, {
    tools: TOOLS,
    respond: (name) => name === "fine_tool"
      ? { content: [{ type: "text", text: "all good" }] }
      : { content: [{ type: "text", text: 'Input validation error: Unrecognized key: "extra"' }], isError: true },
  });
  seedRea();
  await manageRea(host.runtime, "enable");
});

afterEach(async () => {
  await host.runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => host.runtime.callTool(`mcp.${REA_SERVER}.${name}`, args);

describe("MCP failure hints", () => {
  it("appends the accepted arguments when no server hint applies", async () => {
    host.runtime.setFailureHint(REA_SERVER, undefined);
    const result = await call("strict_tool", { extra: 1 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Accepted arguments for mcp.clai-rea.strict_tool: mode");
  });

  it("lets a server hint replace a failing result with the tool, arguments and original text", async () => {
    const hint = vi.fn(() => "custom guidance");
    host.runtime.setFailureHint(REA_SERVER, hint);
    const result = await call("strict_tool", { extra: 1 });
    expect(result).toMatchObject({ ok: false, output: "custom guidance" });
    expect(hint).toHaveBeenCalledWith(expect.objectContaining({
      args: { extra: 1 }, output: 'Input validation error: Unrecognized key: "extra"', tool: expect.objectContaining({ toolName: "strict_tool", serverName: REA_SERVER }),
    }));
  });

  it("falls back to the default when the hint declines", async () => {
    host.runtime.setFailureHint(REA_SERVER, () => undefined);
    expect((await call("strict_tool", { extra: 1 })).output).toContain("Accepted arguments for mcp.clai-rea.strict_tool");
  });

  it("never runs for a successful call and can be removed", async () => {
    const hint = vi.fn(() => "custom guidance");
    host.runtime.setFailureHint(REA_SERVER, hint);
    expect(await call("fine_tool")).toMatchObject({ ok: true, output: "all good" });
    expect(hint).not.toHaveBeenCalled();
    host.runtime.setFailureHint(REA_SERVER, undefined);
    expect((await call("strict_tool", { extra: 1 })).output).not.toContain("custom guidance");
  });

  it("is scoped to the server it was registered for", async () => {
    host.runtime.setFailureHint("another-server", () => "wrong server");
    expect((await call("strict_tool", { extra: 1 })).output).not.toContain("wrong server");
  });
});
