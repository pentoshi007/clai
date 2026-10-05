import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canOpenQoderBrowser,
  getQoderLoginIdentity,
  loginQoderWithPat,
  pollQoderDeviceAuth,
  QODER_DEVICE_CLIENT_ID,
  startQoderDeviceAuth,
} from "../src/llm/qoder/qoder-login.js";
import { parseQoderCredential } from "../src/llm/qoder/qoder-credential.js";
import { parseQoderToken } from "../src/llm/qoder/qoder-auth.js";

const identity = { machineId: "fixture-machine", machineToken: "fixture-umid", machineCode: "fixture-code" };
const directories: string[] = [];
const json = (payload: object, status = 200) => new Response(JSON.stringify(payload), { status });
const profile = () => json({ id: "qoder-account", name: "Example", email: "example@test.invalid", data_policy_agreed: true });

function tokenResponse() {
  return json({ token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, refresh_token_expires_in: 86400 });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Qoder CLI-compatible authentication", () => {
  it("constructs the CLI PKCE device URL without exposing the verifier", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const url = new URL(start.authUrl);
    expect(url.origin + url.pathname).toBe("https://qoder.com/device/selectAccounts");
    expect(url.searchParams.get("client_id")).toBe(QODER_DEVICE_CLIENT_ID);
    expect(url.searchParams.get("challenge_method")).toBe("S256");
    expect(url.searchParams.get("challenge")).toBe(createHash("sha256").update(start.verifier).digest("base64url"));
    expect(url.searchParams.get("nonce")).toBe(start.nonce);
    expect(url.searchParams.get("machine_id")).toBe(identity.machineId);
    expect(url.searchParams.get("machine_token")).toBe(identity.machineToken);
    expect(url.searchParams.has("verifier")).toBe(false);
    expect(start.verifier.length).toBeGreaterThanOrEqual(43);
    expect(start.verifier.length).toBeLessThanOrEqual(128);
    expect((await startQoderDeviceAuth({ identity })).nonce).not.toBe(start.nonce);
  });

  it("polls 404 pending then validates the profile and signs the credential", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ errorCode: "pending" }, 404))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(profile());
    const result = await pollQoderDeviceAuth(start, { fetcher, intervalMs: 1 });
    expect(result).toMatchObject({ uid: "qoder-account", email: "example@test.invalid", loginMethod: "browser", accessToken: "fixture-access", refreshToken: "fixture-refresh", ...identity });
    expect(result.expireTime).toBeGreaterThan(Date.now() / 1000 + 3500);
    expect(result.refreshTokenExpireTime).toBeGreaterThan(Date.now() / 1000 + 86000);
    expect(result.encryptUserInfo).toBeTruthy();
    expect(result.key).toBeTruthy();
    const poll = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(poll.pathname).toBe("/api/v1/deviceToken/poll");
    expect(poll.searchParams.get("verifier")).toBe(start.verifier);
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({ Authorization: "Bearer fixture-access" });
    expect(String(fetcher.mock.calls[2]?.[0])).toBe("https://openapi.qoder.sh/api/v1/userinfo");
  });

  it("exchanges a PAT with machine metadata and retains the PAT refresh strategy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(profile());
    const result = await loginQoderWithPat(" fixture-pat ", { identity, fetcher });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ personal_token: "fixture-pat", machine_id: "fixture-code", machine_token: "fixture-umid" });
    expect(result).toMatchObject({ personalAccessToken: "fixture-pat", loginMethod: "token", uid: "qoder-account" });
    expect(result.encryptUserInfo).toBeTruthy();
  });

  it("rejects an empty PAT without any request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(loginQoderWithPat(" ", { identity, fetcher })).rejects.toThrow("required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects authentication denial without treating it as pending", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ errorMessage: "denied" }, 403));
    await expect(pollQoderDeviceAuth(start, { fetcher, intervalMs: 1 })).rejects.toThrow("denied");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{}, { token: "access-without-identity" }])("rejects incomplete login responses %j", async (payload) => {
    const start = await startQoderDeviceAuth({ identity });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload)).mockResolvedValueOnce(json({}));
    await expect(pollQoderDeviceAuth(start, { fetcher, intervalMs: 1 })).rejects.toThrow(/account id|access token/);
  });

  it("bounds pending login by the timeout", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 404));
    await expect(pollQoderDeviceAuth(start, { fetcher, intervalMs: 1, timeoutMs: 25 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalled();
  });

  it("cancels pending polling and does not fetch a profile", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return json({}, 404);
    });
    await expect(pollQoderDeviceAuth(start, { fetcher, signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds consecutive transport failures", async () => {
    const start = await startQoderDeviceAuth({ identity });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
    await expect(pollQoderDeviceAuth(start, { fetcher, intervalMs: 1 })).rejects.toThrow("network down");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ DISPLAY: ":0" }, true],
    [{ WAYLAND_DISPLAY: "wayland-0" }, true],
    [{ MIR_SOCKET: "socket" }, true],
    [{}, false],
    [{ DISPLAY: ":0", SSH_CONNECTION: "remote" }, false],
    [{ DISPLAY: ":0", SSH_TTY: "/dev/pts/1" }, false],
    [{ DISPLAY: ":0", CI: "1" }, false],
    [{ DISPLAY: ":0", BROWSER: "www-browser" }, false],
    [{ DISPLAY: ":0", CLAI_NO_BROWSER: "1" }, false],
    [{ DISPLAY: ":0", DEBIAN_FRONTEND: "noninteractive" }, false],
  ] as const)("detects browser availability for %j", (env, expected) => {
    expect(canOpenQoderBrowser(env, "linux")).toBe(expected);
  });

  it("persists a restrictive standalone identity without requiring qodercli", async () => {
    const home = await mkdtemp(join(tmpdir(), "qoder-identity-"));
    directories.push(home);
    const options = { qoderHome: join(home, "absent-cli"), claiHome: join(home, "clai") };
    const [first, second] = await Promise.all([getQoderLoginIdentity(options), getQoderLoginIdentity(options)]);
    expect(first).toEqual(second);
    const path = join(options.claiHome, "qoder-machine-id");
    expect(await readFile(path, "utf8")).toBe(first.machineId);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("normalizes supported expiration formats", () => {
    expect(parseQoderToken({ device_token: "t", expires_at: "2030-01-01T00:00:00Z" }).expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(parseQoderToken({ token: "t", expires_at: 1_900_000_000 }).expiresAt).toBe(1_900_000_000_000);
  });

  it.each(["null", "[]", "1", "{}", '{"accessToken":""}'])("rejects malformed stored credentials %s", (raw) => {
    expect(() => parseQoderCredential(raw)).toThrow();
  });
});
