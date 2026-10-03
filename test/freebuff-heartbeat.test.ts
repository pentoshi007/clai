import { afterEach, describe, expect, it, vi } from "vitest";
import { FreebuffSessionManager } from "../src/llm/freebuff-session.js";
import { freebuffHeartbeatDelay, freebuffHeartbeatRetryDelay } from "../src/llm/freebuff-session-api.js";

const TOKEN = "freebuff-heartbeat-token-123456";
const managers: FreebuffSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Freebuff CLI heartbeat scheduling", () => {
  it("matches the CLI's 30-second jitter, expiry boundary and bounded retry backoff", () => {
    expect(freebuffHeartbeatDelay(undefined, 0, 0)).toBe(24_000);
    expect(freebuffHeartbeatDelay(undefined, 0, 1)).toBe(36_000);
    expect(freebuffHeartbeatDelay(500, 0, 0.5)).toBe(1_500);
    expect(freebuffHeartbeatDelay(-1_000, 0, 0.5)).toBe(1_000);
    expect(freebuffHeartbeatRetryDelay(1, undefined, 0)).toBe(10_000);
    expect(freebuffHeartbeatRetryDelay(1, undefined, 1)).toBe(20_000);
    expect(freebuffHeartbeatRetryDelay(20, 600_000, 1)).toBe(300_000);
    expect(freebuffHeartbeatRetryDelay(1, 50_000, 0.5)).toBe(55_000);
  });

  it("heartbeats a persistent claim and invalidates a superseded session", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return Response.json({ status: "active", instanceId: "cli:heart", model: "m", remainingMs: 3_600_000 });
      if (init?.method === "GET") return Response.json({ status: "superseded" });
      return Response.json({ status: "ended" });
    });
    const manager = new FreebuffSessionManager({ fetch: fetchMock });
    managers.push(manager);
    await manager.ensureAdmission(TOKEN, "m");
    expect(manager.hasActiveClaim(TOKEN, "m")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.hasActiveClaim(TOKEN, "m")).toBe(false);
    const get = fetchMock.mock.calls.find((call) => call[1]?.method === "GET")!;
    expect(new Headers(get[1]?.headers).get("x-freebuff-heartbeat")).toBe("1");
    expect(new Headers(get[1]?.headers).get("x-freebuff-compact-session")).toBe("1");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases the attempt when the superseded-admission retry fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === "POST") return Response.json({ error: "session_superseded" }, { status: 409 });
      return Response.json({ status: "ended" });
    });
    const manager = new FreebuffSessionManager({ fetch: fetchMock });
    managers.push(manager);
    await expect(manager.ensureAdmission(TOKEN, "m")).rejects.toThrow(/409/);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(manager.hasActiveClaim(TOKEN, "m")).toBe(false);
  });
});
