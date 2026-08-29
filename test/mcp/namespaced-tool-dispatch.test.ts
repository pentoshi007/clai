import { describe, expect, it } from "vitest";
import {
  allocateWireNames,
  canonicalToolName,
  toolIdentity,
} from "../../src/mcp/names.js";
import {
  fromWireName,
  registerWireName,
  registerWireNamesFor,
  sanitizeToolName,
} from "../../src/llm/tool-protocol.js";

const SERVER = "io.github.github/github-mcp-server";
const TOOLS = [
  "get_me",
  "list_commits",
  "add_comment_to_pending_review",
  "search_commits",
];

const allocated = allocateWireNames(
  TOOLS.map((toolName) => ({ serverName: SERVER, toolName })),
);

for (const toolName of TOOLS) {
  registerWireName(
    canonicalToolName(SERVER, toolName),
    allocated.get(toolIdentity(SERVER, toolName))!,
  );
}
for (const builtin of ["fs.read", "fs.write", "fs.writeMany", "shell.exec"]) {
  registerWireNamesFor(builtin);
}

const canonical = canonicalToolName(SERVER, "get_me");
const wire = allocated.get(toolIdentity(SERVER, "get_me"))!;

describe("namespaced MCP tool dispatch", () => {
  it("sends a wire name every provider accepts as a function name", () => {
    for (const name of allocated.values()) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it("keeps a slashed canonical name intact instead of truncating at the slash", () => {
    expect(sanitizeToolName(canonical)).toBe(canonical);
  });

  it("resolves the exact wire name back to the canonical tool", () => {
    expect(fromWireName(wire)).toBe(canonical);
  });

  it("resolves the canonical name the tool catalog advertises", () => {
    expect(fromWireName(canonical)).toBe(canonical);
  });

  it("resolves the un-hashed underscore form a model is likely to guess", () => {
    expect(fromWireName("mcp_io_github_github_github_mcp_server_get_me")).toBe(canonical);
  });

  it("resolves a mixed slash and underscore guess", () => {
    expect(fromWireName("mcp_io_github_github/github-mcp-server_get_me")).toBe(canonical);
  });

  it("resolves a namespaced name wrapped in model channel junk", () => {
    expect(fromWireName(`${canonical}<|channel|>commentary`)).toBe(canonical);
    expect(fromWireName(`functions.${canonical}`)).toBe(canonical);
  });

  it("resolves a long namespaced tool whose wire name was hash-truncated", () => {
    const longCanonical = canonicalToolName(SERVER, "add_comment_to_pending_review");
    const longWire = allocated.get(
      toolIdentity(SERVER, "add_comment_to_pending_review"),
    )!;
    expect(fromWireName(longWire)).toBe(longCanonical);
    expect(fromWireName(longCanonical)).toBe(longCanonical);
  });

  it("still resolves built-in tools in both wire and canonical form", () => {
    expect(fromWireName("fs_write")).toBe("fs.write");
    expect(fromWireName("fs.write")).toBe("fs.write");
    expect(fromWireName("fs_write_many")).toBe("fs.writeMany");
    expect(fromWireName("shell_exec")).toBe("shell.exec");
  });

  it("does not confuse two namespaced tools that share a prefix", () => {
    expect(fromWireName(allocated.get(toolIdentity(SERVER, "list_commits"))!)).toBe(
      canonicalToolName(SERVER, "list_commits"),
    );
    expect(fromWireName(allocated.get(toolIdentity(SERVER, "search_commits"))!)).toBe(
      canonicalToolName(SERVER, "search_commits"),
    );
  });
});
