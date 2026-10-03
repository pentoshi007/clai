import { afterEach, describe, expect, it, vi } from "vitest";
import { FreebuffSessionManager } from "../src/llm/freebuff-session.js";

const token = "slot-test-token-1234567890";
const managers: FreebuffSessionManager[] = [];

function setup(refusal?: string) {
  const calls: Array<{ method: string; instance: string; model: string }> = [];
  const manager = new FreebuffSessionManager({
    fetch: vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const instance = headers.get("x-freebuff-instance-id") ?? "";
      const model = headers.get("x-freebuff-model") ?? "";
      calls.push({ method, instance, model });
      return Response.json(method === "POST"
        ? refusal ? { status: refusal } : { status: "active", instanceId: instance, model, remainingMs: 3600_000 }
        : { status: "ended" }, { status: refusal && method === "POST" ? 409 : 200 });
    }),
  });
  managers.push(manager);
  return { manager, calls };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

describe("Freebuff owned session slots", () => {
  it("releases the old model's slot before admitting the new model", async () => {
    const { manager, calls } = setup();
    const first = await manager.ensureAdmission(token, "model-a");
    const second = await manager.ensureAdmission(token, "model-b");
    expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE", "POST"]);
    expect(calls[1]?.instance).toBe(first.instanceId);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(manager.hasActiveClaim(token, "model-a")).toBe(false);
    expect(manager.hasActiveClaim(token, "model-b")).toBe(true);
    await manager.release(token, "model-a");
    expect(manager.hasActiveClaim(token, "model-b")).toBe(true);
  });

  it("serializes different-model admissions instead of allocating two slots", async () => {
    const { manager, calls } = setup();
    await Promise.all([
      manager.ensureAdmission(token, "model-a"),
      manager.ensureAdmission(token, "model-b"),
    ]);
    expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE", "POST"]);
    await manager.dispose();
    expect(calls.filter(({ method }) => method === "DELETE")).toHaveLength(2);
  });

  it("does not release a slot while generation is still using it", async () => {
    const { manager, calls } = setup();
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = manager.withAdmission(token, "model-a", undefined, async () => {
      await pending;
      return "first";
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = manager.withAdmission(token, "model-b", undefined, async () => "second");
    await Promise.resolve();
    expect(calls.map(({ method }) => method)).toEqual(["POST"]);
    finish();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE", "POST"]);
  });

  it("skips aborted queued work and continues after a failed generation", async () => {
    const { manager, calls } = setup();
    let finish = (): void => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = manager.withAdmission(token, "model-a", undefined, async () => {
      await pending;
      throw new Error("generation failed");
    });
    const failed = expect(first).rejects.toThrow("generation failed");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const controller = new AbortController();
    const skipped = vi.fn(async () => "skipped");
    const second = manager.withAdmission(token, "model-b", controller.signal, skipped);
    const cancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const third = manager.withAdmission(token, "model-a", undefined, async () => "third");
    finish();
    await Promise.all([failed, cancelled]);
    expect(await third).toBe("third");
    expect(skipped).not.toHaveBeenCalled();
    expect(calls.map(({ method }) => method)).toEqual(["POST"]);
  });

  it("releases an expiring owned attempt before its replacement", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { manager, calls } = setup();
    const first = await manager.ensureAdmission(token, "model-a");
    clock.mockReturnValue(now + 3600_000);
    await manager.ensureAdmission(token, "model-a");
    expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE", "POST"]);
    expect(calls[1]?.instance).toBe(first.instanceId);
  });

  it.each(["premium_slot_taken", "purchase_in_use", "purchase_capacity"])(
    "cleans only its refused attempt for %s and preserves the server error",
    async (refusal) => {
      const { manager, calls } = setup(refusal);
      await expect(manager.ensureAdmission(token, "model-a")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("concurrent-session limit") });
      expect(calls.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
      expect(calls[1]?.instance).toBe(calls[0]?.instance);
      expect(manager.hasActiveClaim(token, "model-a")).toBe(false);
    },
  );
});
