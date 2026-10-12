import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion, runUpdate } from "../src/commands/update.js";
import { fetchLatestRelease } from "../src/commands/update/metadata.js";
import { compareVersions } from "../src/commands/update/verification.js";
import { createCurrentUpdatesPort } from "../src/app/adapters/current-updates-adapter.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("validated and bounded release metadata", () => {
  it("validates the tag and uses an official release URL instead of external JSON links", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://evil.test/", published_at: "2026-10-11T12:00:00Z" })));
    expect(await fetchLatestRelease()).toEqual({ tag_name: "v9.9.9", html_url: "https://github.com/pentoshi007/clai/releases/tag/v9.9.9", published_at: "2026-10-11T12:00:00.000Z" });
  });
  it.each([null, [], {}, { tag_name: 99 }, { tag_name: "latest" }, { tag_name: "9.9.9 && bad" }, { tag_name: "1.02.3" }])("rejects malformed metadata %j", async (value) => {
    vi.stubEnv("CLAI_NO_MIRROR", "1");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(value)));
    expect(await fetchLatestVersion()).toBeUndefined();
  });
  it("falls back to validated mirror metadata after an invalid GitHub response", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("api.github.com") ? { tag_name: {} } : { version: "v9.9.9" })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchLatestVersion()).toBe("9.9.9");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid JSON, oversized bodies and truncated content", async () => {
    vi.stubEnv("CLAI_NO_MIRROR", "1");
    for (const response of [new Response("not json"), new Response("x".repeat(256 * 1024 + 1)), new Response('{"tag_name":"v9.9.9"}', { headers: { "content-length": "500" } })]) {
      vi.stubGlobal("fetch", async () => response);
      expect(await fetchLatestVersion()).toBeUndefined();
    }
  });
  it("keeps the deadline active while a response body stalls", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CLAI_NO_MIRROR", "1");
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) { options.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); } })));
    const result = fetchLatestVersion();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toBeUndefined();
  });
  it("does not fetch or fall back after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(fetchLatestVersion(controller.signal)).rejects.toThrow(/cancelled/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports metadata failure with a failing CLI exit code and removes signal listeners", async () => {
    vi.stubEnv("CLAI_NO_MIRROR", "1");
    vi.stubGlobal("fetch", async () => new Response("offline", { status: 503 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const interrupts = process.listenerCount("SIGINT");
    const terminations = process.listenerCount("SIGTERM");
    await runUpdate();
    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join(" ")).toContain("valid update metadata");
    expect(process.listenerCount("SIGINT")).toBe(interrupts);
    expect(process.listenerCount("SIGTERM")).toBe(terminations);
  });
  it("passes UI cancellation through the update port to metadata lookup", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await createCurrentUpdatesPort(fetchLatestVersion, () => undefined).check(controller.signal);
    expect(result).toMatchObject({ state: "error", detail: expect.stringContaining("cancelled") });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["invalid", "1.2.3 && bad", "1.02.3"])("never reports current for invalid UI metadata %s", async (version) => {
    expect(await createCurrentUpdatesPort(async () => version, () => undefined).check()).toMatchObject({ state: "unknown" });
  });
  it("orders stable, prerelease and build versions correctly", () => {
    expect(compareVersions("9.9.9", "9.9.9-rc.10")).toBeGreaterThan(0);
    expect(compareVersions("9.9.9-rc.10", "9.9.9-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("9.9.9+build.2", "9.9.9+build.1")).toBe(0);
  });
});
