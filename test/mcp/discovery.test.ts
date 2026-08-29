import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { discoverMcpServers } from "../../src/mcp/discovery.js";
import { redactSecrets, redactServerConfig } from "../../src/mcp/format.js";
import type { McpHttpConfig, McpStdioConfig } from "../../src/mcp/types.js";

let root: string;
let workspace: string;
let home: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_CONFIG_HOME: join(home, ".config"), ...extra };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clai-mcp-discovery-"));
  workspace = join(root, "proj", "sub");
  home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(root, "proj", ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discovery precedence and shadowing", () => {
  it("prefers the closest .mcp.json and shadows farther files of the same kind", () => {
    writeJson(join(workspace, ".mcp.json"), {
      mcpServers: { shared: { command: "close-bin", args: [] } },
    });
    writeJson(join(root, "proj", ".mcp.json"), {
      mcpServers: {
        shared: { command: "far-bin" },
        only_far: { command: "far-only" },
      },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const shared = result.servers.find((server) => server.name === "shared");
    expect(shared?.source.kind).toBe("mcp-project");
    expect((shared?.config as McpStdioConfig).command).toBe("close-bin");
    expect(shared?.source.depth).toBe(0);

    expect(result.servers.find((server) => server.name === "only_far")).toBeDefined();
    const shadow = result.shadowed.find((server) => server.name === "shared");
    expect(shadow?.shadowedBy.depth).toBe(0);
    expect(shadow?.source.depth).toBe(1);
  });

  it("applies declared project-source precedence before compatibility files", () => {
    writeJson(join(root, "proj", ".mcp.json"), {
      mcpServers: { db: { command: "mcp-db" }, mconly: { command: "m" } },
    });
    writeJson(join(root, "proj", ".github", "mcp.json"), {
      servers: { db: { command: "github-db" }, ghonly: { command: "gh" } },
    });
    writeJson(join(workspace, ".vscode", "mcp.json"), {
      servers: { db: { command: "vscode-db" }, vsonly: { command: "vs" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const db = result.servers.find((server) => server.name === "db");
    expect((db?.config as McpStdioConfig).command).toBe("mcp-db");
    expect(db?.source.kind).toBe("mcp-project");
    expect(result.servers.map((server) => server.name).sort()).toEqual([
      "db",
      "ghonly",
      "mconly",
      "vsonly",
    ]);
    expect(result.shadowed.filter((server) => server.name === "db")).toHaveLength(2);
  });

  it("shadows equivalent endpoint aliases while retaining distinct configurations", () => {
    writeJson(join(workspace, ".clai", "mcp.json"), {
      servers: {
        notion: {
          url: "https://mcp.notion.com/mcp",
          auth: { kind: "oauth" },
        },
        notionApiKey: {
          url: "https://mcp.notion.com/mcp",
          auth: { kind: "bearer", token: "different-account" },
        },
        notionSubset: {
          url: "https://mcp.notion.com/mcp",
          auth: { kind: "oauth" },
          tools: ["search"],
        },
        notionHeaders: {
          url: "https://mcp.notion.com/sse",
          headers: { "x-workspace": "second" },
        },
        rootEndpoint: {
          url: "https://mcp.notion.com/",
        },
      },
    });
    writeJson(join(home, ".config", "Code", "User", "mcp.json"), {
      servers: {
        "makenotion/notion-mcp-server": {
          url: "https://mcp.notion.com/sse",
          type: "sse",
        },
        distinctPath: {
          url: "https://mcp.notion.com/workspace/sse",
        },
      },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers.map((server) => server.name).sort()).toEqual([
      "distinctPath",
      "notion",
      "notionApiKey",
      "notionHeaders",
      "notionSubset",
      "rootEndpoint",
    ]);
    expect(result.servers.find((server) => server.name === "notion")?.source.kind).toBe(
      "clai-project",
    );
    expect(
      result.shadowed.find(
        (server) => server.name === "makenotion/notion-mcp-server",
      ),
    ).toMatchObject({
      source: { kind: "vscode-user" },
      shadowedBy: { kind: "clai-project" },
      shadowedByName: "notion",
    });
  });

  it("names the live server for same-name shadowing so reconnect can resolve it", () => {
    writeJson(join(workspace, ".clai", "mcp.json"), {
      servers: { docs: { url: "https://docs.example.com/mcp" } },
    });
    writeJson(join(home, ".config", "Code", "User", "mcp.json"), {
      servers: { docs: { url: "https://other.example.com/mcp" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers.map((server) => server.name)).toEqual(["docs"]);
    expect(result.shadowed).toHaveLength(1);
    expect(result.shadowed[0]).toMatchObject({
      name: "docs",
      shadowedByName: "docs",
    });
  });

  it("loads CLAI_MCP_CONFIG path lists at explicit-override precedence", () => {
    const extA = join(root, "ext-a.json");
    const extB = join(root, "ext-b.json");
    writeJson(extA, { mcpServers: { alpha: { command: "alpha-bin" } } });
    writeJson(extB, { servers: { beta: { url: "https://beta.example/mcp" } } });
    writeJson(join(workspace, ".mcp.json"), {
      mcpServers: { alpha: { command: "project-alpha" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv({ CLAI_MCP_CONFIG: [extA, extB].join(delimiter) }),
      platform: "linux",
    });

    const alpha = result.servers.find((server) => server.name === "alpha");
    expect((alpha?.config as McpStdioConfig).command).toBe("alpha-bin");
    expect(alpha?.source.kind).toBe("clai-env");
    expect(result.shadowed.some((server) => server.name === "alpha")).toBe(true);

    const beta = result.servers.find((server) => server.name === "beta");
    expect(beta?.source.kind).toBe("clai-env");
    expect((beta?.config as McpHttpConfig).transport).toBe("http");
  });

  it("reads user Claude Code and VS Code locations", () => {
    writeJson(join(home, ".claude.json"), {
      mcpServers: { claudeServer: { command: "claude-bin" } },
    });
    writeJson(join(home, ".config", "Code", "User", "mcp.json"), {
      servers: { copilotServer: { url: "https://copilot.example/mcp", type: "http" } },
    });
    writeJson(join(home, ".config", "Code", "User", "settings.json"), {
      mcp: { servers: { settingsServer: { command: "settings-bin" } } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers.map((server) => server.name).sort()).toEqual([
      "claudeServer",
      "copilotServer",
      "settingsServer",
    ]);
    expect(
      result.servers.find((server) => server.name === "copilotServer")?.source.kind,
    ).toBe("vscode-user");
  });
});

describe("discovery validation", () => {

  it("uses CLAI_MCP_HOME for inherited user compatibility locations", () => {
    const isolatedHome = join(root, "isolated-mcp-home");
    writeJson(join(isolatedHome, ".claude.json"), {
      mcpServers: { isolated: { command: "isolated-server" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      env: {
        XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        CLAI_MCP_HOME: isolatedHome,
      },
      platform: "linux",
    });

    const isolated = result.servers.find((server) => server.name === "isolated");
    expect(isolated?.source.path).toBe(join(isolatedHome, ".claude.json"));
    expect((isolated?.config as McpStdioConfig).command).toBe("isolated-server");
  });
  it("rejects invalid server entries with reasons", () => {
    writeJson(join(workspace, ".mcp.json"), {
      mcpServers: {
        missing: { args: ["x"] },
        both: { command: "c", url: "https://x.example" },
        badtype: { type: "carrier-pigeon", command: "c" },
        okstdio: { command: "good" },
      },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers.map((server) => server.name)).toEqual(["okstdio"]);
    expect(result.invalid.map((server) => server.name).sort()).toEqual([
      "badtype",
      "both",
      "missing",
    ]);
    expect(result.invalid.find((server) => server.name === "missing")?.errors.join(" ")).toMatch(
      /neither command nor url/,
    );
  });

  it("records a warning and continues on malformed JSON", () => {
    writeFileSync(join(workspace, ".mcp.json"), "{ not valid json ");
    writeJson(join(workspace, ".vscode", "mcp.json"), {
      servers: { fine: { command: "ok" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.warnings.some((warning) => warning.includes(".mcp.json"))).toBe(true);
    expect(result.servers.map((server) => server.name)).toEqual(["fine"]);
  });

  it("marks disabled servers without dropping them", () => {
    writeJson(join(workspace, ".mcp.json"), {
      mcpServers: { off: { command: "x", disabled: true } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers[0]?.disabled).toBe(true);
  });

  it("accepts bare .mcp.json maps and reports unresolved substitutions", () => {
    writeJson(join(workspace, ".mcp.json"), {
      bare: { type: "local", command: "run", tools: ["read", "write", "read"] },
      unresolved: { command: "${env:MISSING_MCP_VALUE}" },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const bare = result.servers.find((server) => server.name === "bare");
    expect(bare?.config.transport).toBe("stdio");
    expect(bare?.toolSelection).toEqual(["read", "write"]);
    expect(result.invalid.find((server) => server.name === "unresolved")?.errors.join(" ")).toContain(
      "MISSING_MCP_VALUE",
    );
  });
});

describe("discovery substitution and secret handling", () => {
  it("expands workspaceFolder, env, and input variables", () => {
    writeJson(join(workspace, ".vscode", "mcp.json"), {
      inputs: [
        { id: "region", type: "promptString", default: "us-east" },
        { id: "api-key", type: "promptString", password: true, default: "topsecret" },
      ],
      servers: {
        svc: {
          command: "${workspaceFolder}/bin/run",
          args: ["--region", "${input:region}", "--home", "${env:HOME_VAR}"],
          env: {
            TOKEN: "${env.SECRET_TOKEN}",
            AUTH: "Bearer ${input:api-key}",
          },
        },
      },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv({ HOME_VAR: "/opt/home", SECRET_TOKEN: "abc123" }),
      platform: "linux",
    });

    const svc = result.servers.find((server) => server.name === "svc");
    const config = svc?.config as McpStdioConfig;
    expect(config.command).toBe(`${workspace}/bin/run`);
    expect(config.args).toEqual(["--region", "us-east", "--home", "/opt/home"]);
    expect(config.env.TOKEN).toBe("abc123");
    expect(config.env.AUTH).toBe("Bearer topsecret");
    expect(svc?.secretValues).toContain("topsecret");
    expect(svc?.secretValues).toContain("abc123");
  });

  it("redacts secret values and env in the display projection", () => {
    writeJson(join(workspace, ".mcp.json"), {
      mcpServers: {
        svc: {
          command: "run",
          args: ["--key", "leaked-in-args"],
          env: { TOKEN: "leaked-in-args" },
        },
      },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const svc = result.servers.find((server) => server.name === "svc");
    expect(svc).toBeDefined();
    const display = redactServerConfig(svc!);
    expect(display.env).toEqual({ TOKEN: "***" });
    expect(display.args).toEqual(["--key", "***"]);
    const rendered = redactSecrets(JSON.stringify(svc!.config), svc!.secretValues);
    expect(rendered).not.toContain("leaked-in-args");
  });
});


describe("native clai MCP sources", () => {
  it("walks to the git root and gives the nearest .clai/mcp.json native precedence", () => {
    writeJson(join(workspace, ".clai", "mcp.json"), {
      shared: { command: "nearest-clai" },
    });
    writeJson(join(root, "proj", ".clai", "mcp.json"), {
      shared: { command: "root-clai" },
      rootOnly: { command: "root-only" },
    });
    writeJson(join(workspace, ".mcp.json"), {
      shared: { command: "generic-project" },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const shared = result.servers.find((server) => server.name === "shared");
    expect(shared?.source.kind).toBe("clai-project");
    expect(shared?.source.depth).toBe(0);
    expect((shared?.config as McpStdioConfig).command).toBe("nearest-clai");
    expect(result.servers.find((server) => server.name === "rootOnly")?.source.depth).toBe(1);
    expect(result.shadowed.filter((server) => server.name === "shared")).toHaveLength(2);
  });

  it("falls back after malformed nearest native config without abandoning parent discovery", () => {
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    writeFileSync(join(workspace, ".clai", "mcp.json"), "{ broken");
    writeJson(join(root, "proj", ".clai", "mcp.json"), {
      servers: { fallback: { command: "parent-clai" } },
    });
    writeJson(join(workspace, ".mcp.json"), {
      servers: { fallback: { command: "generic" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    const fallback = result.servers.find((server) => server.name === "fallback");
    expect(fallback?.source.kind).toBe("clai-project");
    expect(fallback?.source.depth).toBe(1);
    expect((fallback?.config as McpStdioConfig).command).toBe("parent-clai");
    expect(result.warnings.some((warning) => warning.includes(".clai/mcp.json"))).toBe(true);
  });

  it("reads native clai user files before inherited user compatibility files", () => {
    writeJson(join(home, ".clai", "mcp.json"), {
      native: { command: "native-home" },
      shared: { command: "native-winner" },
    });
    writeJson(join(home, ".config", "clai", "mcp.json"), {
      xdg: { command: "native-xdg" },
    });
    writeJson(join(home, ".copilot", "mcp-config.json"), {
      mcpServers: { shared: { command: "copilot-shadow" } },
    });

    const result = discoverMcpServers({
      workspaceFolder: workspace,
      homeDir: home,
      env: baseEnv(),
      platform: "linux",
    });

    expect(result.servers.find((server) => server.name === "native")?.source.kind).toBe(
      "clai-user",
    );
    expect(result.servers.find((server) => server.name === "xdg")?.source.kind).toBe(
      "clai-user",
    );
    expect(
      (result.servers.find((server) => server.name === "shared")?.config as McpStdioConfig)
        .command,
    ).toBe("native-winner");
    expect(result.shadowed.find((server) => server.name === "shared")?.source.kind).toBe(
      "copilot-user",
    );
  });
});
