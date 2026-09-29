import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFreebuffFingerprintId,
  importExistingFreebuffToken,
  isFreebuffHeadless,
  pollFreebuffDeviceAuth,
  startFreebuffDeviceAuth,
  validateFreebuffToken,
} from "../src/llm/freebuff-auth.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Freebuff authentication protocol", () => {
  it("forms the source-compatible login challenge request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        loginUrl: "https://freebuff.com/login?code=abc",
        fingerprintHash: "hash",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    );
    const result = await startFreebuffDeviceAuth(
      { fingerprintId: "codebuff-cli-fixture" },
      { fetch: fetchMock },
    );
    expect(result).toEqual({
      loginUrl: "https://freebuff.com/login?code=abc",
      fingerprintId: "codebuff-cli-fixture",
      fingerprintHash: "hash",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://freebuff.com/api/auth/cli/code");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ fingerprintId: "codebuff-cli-fixture" });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("accepts a numeric epoch expiresAt from the live API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        loginUrl: "https://freebuff.com/login?auth_code=abc",
        fingerprintHash: "hash",
        expiresAt: 1790706112538,
        expiresInMs: 3600000,
      }),
    );
    const result = await startFreebuffDeviceAuth(
      { fingerprintId: "codebuff-cli-fixture" },
      { fetch: fetchMock },
    );
    expect(result.expiresAt).toBe("1790706112538");
  });

  it("polls pending status and returns the opaque bearer token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "pending" }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ user: { id: "u1", email: "user@example.com", authToken: "opaque-token-value" } }),
      );
    const sleep = vi.fn(async () => undefined);
    const result = await pollFreebuffDeviceAuth(
      {
        loginUrl: "https://freebuff.com/login",
        fingerprintId: "codebuff-cli-fixture",
        fingerprintHash: "hash+value",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      {},
      { fetch: fetchMock, sleep, now: () => 0 },
    );
    expect(result.token).toBe("opaque-token-value");
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/auth/cli/status");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fingerprintId: "codebuff-cli-fixture",
      fingerprintHash: "hash+value",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it("validates tokens against the identity endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "u1" }));
    await validateFreebuffToken("opaque-token-value", {}, { fetch: fetchMock });
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://www.codebuff.com/api/v1/me");
    expect(url.searchParams.get("fields")).toBe("id,email");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer opaque-token-value");
  });

  it("returns actionable authentication failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: "invalid token" }, { status: 401 }),
    );
    await expect(
      validateFreebuffToken("opaque-token-value", {}, { fetch: fetchMock }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      validateFreebuffToken("opaque-token-value", {}, { fetch: fetchMock }),
    ).rejects.toThrow("clai auth freebuff");
  });

  it("imports upstream environment and credential-file tokens", async () => {
    await expect(
      importExistingFreebuffToken({
        env: { CODEBUFF_API_KEY: "environment-token" },
        homeDir: "/unused",
      }),
    ).resolves.toEqual({ token: "environment-token", source: "CODEBUFF_API_KEY" });

    const root = await mkdtemp(join(tmpdir(), "clai-freebuff-auth-"));
    roots.push(root);
    const dir = join(root, ".config", "manicode");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "credentials.json"),
      JSON.stringify({ default: { authToken: "credential-token", email: "user@example.com" } }),
    );
    const imported = await importExistingFreebuffToken({ env: {}, homeDir: root });
    expect(imported?.token).toBe("credential-token");
    expect(imported?.source).toBe(join(dir, "credentials.json"));
  });

  it("detects remote/headless terminals and emits upstream fingerprint format", () => {
    expect(isFreebuffHeadless({ SSH_CONNECTION: "host" }, "linux")).toBe(true);
    expect(isFreebuffHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isFreebuffHeadless({}, "linux")).toBe(true);
    expect(createFreebuffFingerprintId()).toMatch(/^codebuff-cli-[A-Za-z0-9_-]{8}$/);
  });
});
