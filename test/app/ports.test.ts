import { describe, expect, it } from "vitest";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { createCurrentJobsPort } from "../../src/app/adapters/current-jobs-adapter.js";
import { createInMemoryClipboardPort } from "../../src/app/adapters/in-memory-clipboard-adapter.js";
import { createCurrentUpdatesPort } from "../../src/app/adapters/current-updates-adapter.js";
import type { JobManager } from "../../src/tools/jobs.js";
import { createPlan } from "../../src/store/plan.js";

describe("V2-022 persistence port", () => {
  it("round-trips a plan and deletes it", async () => {
    const port = createCurrentPersistencePort();
    const sessionId = `port-test-${Math.random().toString(36).slice(2)}`;
    const plan = createPlan({
      sessionId,
      goal: "g",
      detail: "d",
      taskTitles: ["one", "two"],
    });
    await port.savePlan(plan);
    const loaded = await port.loadPlan(sessionId);
    expect(loaded?.goal).toBe("g");
    expect(loaded?.tasks).toHaveLength(2);
    await port.deletePlan(sessionId);
    expect(await port.loadPlan(sessionId)).toBeUndefined();
  });
});

describe("V2-022 jobs port", () => {
  it("delegates every call to the job manager", () => {
    const calls: string[] = [];
    const fake = {
      listJobs: () => (calls.push("list"), { ok: true, output: "" }),
      getRunningJobs: () => (calls.push("running"), []),
      getJob: (id: string) => (calls.push(`get:${id}`), undefined),
      tailJob: async (id: string) => (calls.push(`tail:${id}`), { ok: true, output: "" }),
      stopJob: (id: string) => (calls.push(`stop:${id}`), { ok: true, output: "" }),
      startJob: async (cmd: string) => (calls.push(`start:${cmd}`), { ok: true, output: "" }),
    } as unknown as JobManager;
    const port = createCurrentJobsPort(fake);
    port.list();
    port.running();
    port.get("a");
    void port.tail("b");
    port.stop("c");
    void port.start("echo hi");
    expect(calls).toEqual([
      "list",
      "running",
      "get:a",
      "tail:b",
      "stop:c",
      "start:echo hi",
    ]);
  });
});

describe("V2-022 clipboard port", () => {
  it("stores and returns the last copied text in memory", async () => {
    const clip = createInMemoryClipboardPort();
    expect(clip.lastText).toBeUndefined();
    await clip.writeText("hello");
    expect(clip.lastText).toBe("hello");
    expect(await clip.readText?.()).toBe("hello");
  });
});

describe("V2-022 updates port", () => {
  it("reports unknown — never current — when no version could be fetched", async () => {
    const status = await createCurrentUpdatesPort(
      async () => undefined,
      () => undefined,
    ).check();
    expect(status.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.state).toBe("unknown");
    expect(status.updateAvailable).toBe(false);
  });

  it("reports unknown with a reason while offline", async () => {
    const status = await createCurrentUpdatesPort(
      async () => "999.0.0",
      () => "offline mode",
    ).check();
    expect(status.state).toBe("unknown");
    expect(status.detail).toBe("offline mode");
  });

  it("reports an error when the check throws", async () => {
    const status = await createCurrentUpdatesPort(
      async () => {
        throw new Error("network down");
      },
      () => undefined,
    ).check();
    expect(status.state).toBe("error");
    expect(status.detail).toContain("network down");
  });

  it("flags an update when the injected latest version is newer", async () => {
    const port = createCurrentUpdatesPort(
      async () => "999.0.0",
      () => undefined,
    );
    const status = await port.check();
    expect(status.latestVersion).toBe("999.0.0");
    expect(status.state).toBe("update-available");
    expect(status.updateAvailable).toBe(true);
  });

  it("reports current only after a successful comparison", async () => {
    const port = createCurrentUpdatesPort(
      async () => "0.0.1",
      () => undefined,
    );
    const status = await port.check();
    expect(status.state).toBe("current");
    expect(status.updateAvailable).toBe(false);
  });
});
