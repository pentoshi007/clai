import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  displayMcpConfigPath,
  parseMcpServerSnippet,
  projectMcpConfigPath,
  writeProjectMcpServer,
} from "../../src/mcp/config-file.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "clai-mcp-config-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("parseMcpServerSnippet", () => {
  it.each([
    [
      "named definition",
      '{"name":"docs","command":"docs-server","args":[]}',
    ],
    [
      "servers wrapper",
      '{"servers":{"docs":{"command":"docs-server"}}}',
    ],
    [
      "mcpServers wrapper",
      '{"mcpServers":{"docs":{"command":"docs-server"}}}',
    ],
    [
      "bare server map",
      '{"docs":{"command":"docs-server"}}',
    ],
  ])("accepts one server in the %s form", (_label, text) => {
    const result = parseMcpServerSnippet(text, { workspaceFolder: workspace, env: {} });
    expect(result).toEqual({
      ok: true,
      snippet: {
        name: "docs",
        entry: expect.objectContaining({ command: "docs-server" }),
      },
    });
  });

  it("accepts JSONC comments and trailing commas", () => {
    const result = parseMcpServerSnippet(
      '{\n // project docs\n "servers": { "docs": { "command": "docs-server", }, },\n}',
      { workspaceFolder: workspace, env: {} },
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object", "[]"],
    ["an empty object", "{}"],
    [
      "multiple servers",
      '{"servers":{"one":{"command":"one"},"two":{"command":"two"}}}',
    ],
    ["an invalid definition", '{"name":"docs","command":""}'],
  ])("rejects %s", (_label, text) => {
    const result = parseMcpServerSnippet(text, { workspaceFolder: workspace, env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("writeProjectMcpServer", () => {
  it("creates a deterministic private project config", async () => {
    const result = await writeProjectMcpServer(
      '{"name":"alpha","command":"alpha-server","args":[]}',
      { workspaceFolder: workspace, env: {} },
    );

    expect(result).toMatchObject({
      ok: true,
      displayPath: ".clai/mcp.json",
      serverName: "alpha",
      replaced: false,
    });
    const path = projectMcpConfigPath(workspace);
    expect(readFileSync(path, "utf8")).toBe(
      '{\n  "servers": {\n    "alpha": {\n      "args": [],\n      "command": "alpha-server"\n    }\n  }\n}\n',
    );
    expect(readdirSync(join(workspace, ".clai"))).toEqual(["mcp.json"]);
    if (process.platform !== "win32") {
      expect(statSync(join(workspace, ".clai")).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("merges and sorts servers without clobbering unrelated metadata", async () => {
    const path = projectMcpConfigPath(workspace);
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(
      path,
      `{
        // This object resembles a transport but is project metadata.
        "metadata": { "type": "policy", "url": "https://example.test/policy" },
        "version": 1,
        "servers": {
          "zeta": { "command": "zeta-server", "args": ["--last"] }
        }
      }`,
    );

    const result = await writeProjectMcpServer(
      '{"mcpServers":{"alpha":{"env":{"Z":"last","A":"first"},"command":"alpha-server"}}}',
      { workspaceFolder: workspace, env: {} },
    );

    expect(result).toMatchObject({ ok: true, replaced: false, serverName: "alpha" });
    const body = readFileSync(path, "utf8");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toEqual({
      metadata: { type: "policy", url: "https://example.test/policy" },
      servers: {
        alpha: {
          command: "alpha-server",
          env: { A: "first", Z: "last" },
        },
        zeta: { args: ["--last"], command: "zeta-server" },
      },
      version: 1,
    });
    expect(body.indexOf('"alpha"')).toBeLessThan(body.indexOf('"zeta"'));
  });

  it("replaces a same-name server and canonicalizes mixed compatible maps", async () => {
    const path = projectMcpConfigPath(workspace);
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { docs: { command: "old-docs" } },
        servers: { other: { command: "other-server" } },
        mcp: {
          note: "keep me",
          servers: { nested: { command: "nested-server" } },
        },
      }),
    );

    const result = await writeProjectMcpServer(
      '{"name":"docs","command":"new-docs","args":["--stdio"]}',
      { workspaceFolder: workspace, env: {} },
    );

    expect(result).toMatchObject({ ok: true, replaced: true, serverName: "docs" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcp: { note: "keep me" },
      servers: {
        docs: { args: ["--stdio"], command: "new-docs" },
        nested: { command: "nested-server" },
        other: { command: "other-server" },
      },
    });
  });

  it("canonicalizes a legacy bare server map while retaining scalar metadata", async () => {
    const path = projectMcpConfigPath(workspace);
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ zeta: { command: "zeta" }, version: 2 }),
    );

    const result = await writeProjectMcpServer(
      '{"alpha":{"command":"alpha"}}',
      { workspaceFolder: workspace, env: {} },
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      servers: {
        alpha: { command: "alpha" },
        zeta: { command: "zeta" },
      },
      version: 2,
    });
  });

  it("does not modify an existing config when input or existing JSON is invalid", async () => {
    const path = projectMcpConfigPath(workspace);
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(path, "{ broken");

    const badSnippet = await writeProjectMcpServer("{}", {
      workspaceFolder: workspace,
      env: {},
    });
    expect(badSnippet.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{ broken");

    const badExisting = await writeProjectMcpServer(
      '{"name":"docs","command":"docs-server"}',
      { workspaceFolder: workspace, env: {} },
    );
    expect(badExisting.ok).toBe(false);
    if (!badExisting.ok) expect(badExisting.error).toContain("could not read existing MCP config");
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });

  it("refuses an existing config larger than 1 MiB", async () => {
    const path = projectMcpConfigPath(workspace);
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(path, `{"padding":"${"x".repeat(1024 * 1024)}"}`);

    const result = await writeProjectMcpServer(
      '{"name":"docs","command":"docs-server"}',
      { workspaceFolder: workspace, env: {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("larger than 1 MiB");
  });
});

describe("MCP config paths", () => {
  it("uses the project-local .clai/mcp.json path", () => {
    expect(projectMcpConfigPath(workspace)).toBe(join(workspace, ".clai", "mcp.json"));
    expect(displayMcpConfigPath(projectMcpConfigPath(workspace), workspace)).toBe(
      ".clai/mcp.json",
    );
  });

  it("normalizes backslashes in displayed project-relative paths", () => {
    expect(
      displayMcpConfigPath(join(workspace, ".clai\\mcp.json"), workspace),
    ).toBe(".clai/mcp.json");
  });
});
