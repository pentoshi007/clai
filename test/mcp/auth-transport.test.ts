import { describe, expect, it, vi } from "vitest";
import { StreamableHttpTransport } from "../../src/mcp/transport-http.js";
import { createRequest } from "../../src/mcp/jsonrpc.js";
import type { McpAuthChallenge, McpAuthProvider } from "../../src/mcp/auth/types.js";
import type { McpHttpConfig } from "../../src/mcp/types.js";

const CONFIG: McpHttpConfig = {
  transport: "http",
  url: "https://api.example.com/mcp",
  headers: {},
};

function jsonRpcOk(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { done: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return new Response("nope", {
    status: 401,
    headers: {
      "www-authenticate":
        'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
    },
  });
}

class RecordingProvider implements McpAuthProvider {
  readonly kind = "oauth" as const;
  token = "";
  onUnauthorizedCalls = 0;
  challenges: (McpAuthChallenge | undefined)[] = [];
  async headers(): Promise<Record<string, string>> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }
  async onUnauthorized(challenge: McpAuthChallenge | undefined): Promise<boolean> {
    this.onUnauthorizedCalls += 1;
    this.challenges.push(challenge);
    this.token = "REFRESHED";
    return true;
  }
  liveSecrets(): readonly string[] {
    return this.token ? [this.token] : [];
  }
}

describe("StreamableHttpTransport auth retry", () => {
  it("retries exactly once after a 401 with refreshed headers", async () => {
    const inits: RequestInit[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      inits.push(init ?? {});
      return calls === 1 ? unauthorized() : jsonRpcOk();
    });
    const provider = new RecordingProvider();
    const transport = new StreamableHttpTransport(CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authProvider: provider,
    });
    const response = await transport.request(createRequest(0, "tools/list", {}));
    expect(response).toMatchObject({ result: { done: true } });
    expect(calls).toBe(2);
    expect(provider.onUnauthorizedCalls).toBe(1);
    expect(provider.challenges[0]?.resourceMetadataUrl).toContain(
      "oauth-protected-resource",
    );
    expect(inits[0]?.redirect).toBe("manual");
    expect((inits[1]?.headers as Record<string, string>).authorization).toBe(
      "Bearer REFRESHED",
    );
  });

  it("does not retry more than once and raises an actionable 401 error", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return unauthorized();
    });
    const provider = new RecordingProvider();
    const transport = new StreamableHttpTransport(CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authProvider: provider,
    });
    await expect(transport.request(createRequest(0, "tools/list", {}))).rejects.toThrow(
      /login|authenticate/i,
    );
    expect(calls).toBe(2);
    expect(provider.onUnauthorizedCalls).toBe(1);
  });
});

describe("StreamableHttpTransport redirect handling", () => {
  it("sets redirect:manual and refuses a cross-origin redirect", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response("moved", {
        status: 302,
        headers: { location: "https://evil.example.com/" },
      });
    });
    const transport = new StreamableHttpTransport(CONFIG, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      transport.request(createRequest(0, "tools/list", {})),
    ).rejects.toMatchObject({ kind: "protocol" });
    expect(inits[0]?.redirect).toBe("manual");
  });
});
