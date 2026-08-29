import { describe, expect, it, vi } from "vitest";
import {
  openSystemBrowser,
  runLoopbackAuthorization,
} from "../../src/mcp/auth/loopback.js";
import { McpTransportError } from "../../src/mcp/transport.js";

function drive(useWrongState: boolean): Promise<{ code: string }> {
  return runLoopbackAuthorization({
    buildAuthorizationUrl: (redirectUri, state) =>
      `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    openBrowser: async (url) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const realState = parsed.searchParams.get("state")!;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "AUTHCODE");
      callback.searchParams.set("state", useWrongState ? "not-the-state" : realState);
      await fetch(callback.toString()).catch(() => undefined);
    },
    timeoutMs: 4000,
  });
}

describe("runLoopbackAuthorization", () => {
  it("resolves with the code when the callback state matches", async () => {
    const result = await drive(false);
    expect(result.code).toBe("AUTHCODE");
  });

  it("rejects when the callback state does not match", async () => {
    await expect(drive(true)).rejects.toBeInstanceOf(McpTransportError);
  });
});

function fakeSpawn(): ReturnType<typeof vi.fn> {
  return vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
}

describe("openSystemBrowser", () => {
  it("spawns a non-shell opener for https", async () => {
    const spawnImpl = fakeSpawn();
    await openSystemBrowser("https://example.com/auth", {
      platform: "darwin",
      spawnImpl: spawnImpl as never,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "open",
      ["https://example.com/auth"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("allows loopback http", async () => {
    const spawnImpl = fakeSpawn();
    await openSystemBrowser("http://127.0.0.1:9000/cb", {
      platform: "linux",
      spawnImpl: spawnImpl as never,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "xdg-open",
      ["http://127.0.0.1:9000/cb"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("rejects dangerous and non-loopback schemes", async () => {
    const spawnImpl = fakeSpawn();
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "http://example.com/auth",
    ]) {
      await expect(
        openSystemBrowser(url, { platform: "linux", spawnImpl: spawnImpl as never }),
      ).rejects.toBeInstanceOf(McpTransportError);
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
