import { describe, expect, it } from "vitest";
import {
  KNOWN_MCP_SERVERS,
  knownMcpServer,
  planKnownMcpInstall,
} from "../../src/mcp/known-servers.js";

describe("knownMcpServer", () => {
  it("resolves exact and partial matches", () => {
    expect(knownMcpServer("github")?.id).toBe("github");
    expect(knownMcpServer("GitHub")?.id).toBe("github");
    expect(knownMcpServer("brave")?.id).toBe("brave-search");
    expect(knownMcpServer("nonexistent-thing")).toBeUndefined();
  });

  it("catalog entries have unique ids and sane summaries", () => {
    const ids = KNOWN_MCP_SERVERS.map((server) => server.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const server of KNOWN_MCP_SERVERS) {
      expect(server.title.length).toBeGreaterThan(0);
      expect(server.summary.length).toBeGreaterThan(0);
      expect(
        typeof server.entry.url === "string" ||
          typeof server.entry.command === "string",
      ).toBe(true);
    }
  });
});

describe("planKnownMcpInstall", () => {
  it("adopts environment variables as ${env:} references", () => {
    const brave = knownMcpServer("brave-search")!;
    const plan = planKnownMcpInstall(brave, {
      env: { BRAVE_API_KEY: "live-key" },
    });
    expect(plan.missingSecrets).toEqual([]);
    expect(plan.adoptedEnvRefs).toEqual(["BRAVE_API_KEY"]);
    expect((plan.entry.env as Record<string, string>).BRAVE_API_KEY).toBe(
      "${env:BRAVE_API_KEY}",
    );
  });

  it("embeds provided literal secrets", () => {
    const brave = knownMcpServer("brave-search")!;
    const plan = planKnownMcpInstall(brave, {
      env: {},
      secrets: { BRAVE_API_KEY: "pasted-key" },
    });
    expect(plan.missingSecrets).toEqual([]);
    expect((plan.entry.env as Record<string, string>).BRAVE_API_KEY).toBe("pasted-key");
  });

  it("reports missing required secrets", () => {
    const brave = knownMcpServer("brave-search")!;
    const plan = planKnownMcpInstall(brave, { env: {} });
    expect(plan.missingSecrets.map((secret) => secret.env)).toEqual([
      "BRAVE_API_KEY",
    ]);
  });

  it("does not require optional secrets", () => {
    const context7 = knownMcpServer("context7")!;
    const plan = planKnownMcpInstall(context7, { env: {} });
    expect(plan.missingSecrets).toEqual([]);
  });

  it("appends workspace default args for filesystem", () => {
    const fs = knownMcpServer("filesystem")!;
    const plan = planKnownMcpInstall(fs, {
      env: {},
      workspaceFolder: "/repo/root",
    });
    expect(plan.entry.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/repo/root",
    ]);
  });

  it("marks oauth servers", () => {
    expect(knownMcpServer("github")!.oauth).toBe(true);
    expect(knownMcpServer("notion")!.oauth).toBe(true);
    expect(knownMcpServer("fetch")!.oauth).toBeUndefined();
  });
});
