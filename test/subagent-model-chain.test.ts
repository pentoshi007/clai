import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let configDir: string;

beforeEach(() => {
  vi.resetModules();
  configDir = mkdtempSync(join(tmpdir(), "clai-subagent-models-"));
  vi.stubEnv("CLAI_CONFIG_DIR", configDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe("subagent model chain", () => {
  it("sanitizes and persists entries", async () => {
    const {
      clearSubagentModelChain,
      getSubagentModelChain,
      setSubagentModelChain,
    } = await import("../src/store/config/subagent-models.js");

    const entries = [
      { provider: " free ", model: " first ", disabled: true },
      { provider: "free", model: "first" },
      { provider: "unknown", model: "discard" },
      { provider: "free", model: "" },
      ...Array.from({ length: 12 }, (_, index) => ({
        provider: "free",
        model: `model-${index}`,
      })),
    ];

    expect(setSubagentModelChain(entries, 99)).toEqual({
      entries: [
        { provider: "free", model: "first", disabled: true },
        ...Array.from({ length: 9 }, (_, index) => ({
          provider: "free",
          model: `model-${index}`,
        })),
      ],
      activeIndex: 9,
    });
    expect(getSubagentModelChain()).toEqual({
      entries: [
        { provider: "free", model: "first", disabled: true },
        ...Array.from({ length: 9 }, (_, index) => ({
          provider: "free",
          model: `model-${index}`,
        })),
      ],
      activeIndex: 9,
    });

    clearSubagentModelChain();
    expect(getSubagentModelChain()).toBeUndefined();
  });

  it("orders active first, wraps, and skips disabled entries", async () => {
    const { resolveSubagentModelChain } = await import(
      "../src/agent/subagents/model-chain.js"
    );

    expect(
      resolveSubagentModelChain({
        customProviders: [],
        subagentModels: {
          activeIndex: 2,
          entries: [
            { provider: "free", model: "one" },
            { provider: "free", model: "two", disabled: true },
            { provider: "free", model: "three" },
            { provider: "free", model: "four" },
          ],
        },
      }),
    ).toEqual([
      { provider: "free", model: "three" },
      { provider: "free", model: "four" },
      { provider: "free", model: "one" },
    ]);
  });

  it("returns no candidates when the chain is absent or disabled", async () => {
    const { resolveSubagentModelChain, subagentModelChainBlocked } = await import(
      "../src/agent/subagents/model-chain.js"
    );

    expect(resolveSubagentModelChain({ customProviders: [] })).toEqual([]);
    expect(subagentModelChainBlocked({ customProviders: [] })).toBe(false);
    expect(
      resolveSubagentModelChain({
        customProviders: [],
        subagentModels: {
          activeIndex: 0,
          entries: [
            { provider: "free", model: "one", disabled: true },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      subagentModelChainBlocked({
        customProviders: [],
        subagentModels: {
          activeIndex: 0,
          entries: [
            { provider: "free", model: "one", disabled: true },
          ],
        },
      }),
    ).toBe(true);
  });

  it("blocks launches only while every configured model is disabled", async () => {
    const { setSubagentModelChain, clearSubagentModelChain } = await import(
      "../src/store/config/subagent-models.js"
    );
    const { SubagentManager } = await import("../src/agent/subagents/manager.js");
    const assignment = { title: "Investigate", prompt: "Read the implementation", cwd: "/tmp", provider: "openai", model: "test" };
    const launch = async (): Promise<string> => {
      const manager = new SubagentManager("parent", { worker: async () => "Done" });
      try {
        return (await manager.wait(manager.start(assignment).id)).status;
      } finally {
        manager.dispose();
      }
    };

    setSubagentModelChain([{ provider: "free", model: "one", disabled: true }]);
    const blocked = new SubagentManager("parent", { worker: async () => "Done" });
    try {
      expect(() => blocked.start(assignment)).toThrow(/All configured subagent models are disabled/);
    } finally {
      blocked.dispose();
    }

    setSubagentModelChain([{ provider: "free", model: "one", disabled: true }, { provider: "free", model: "two" }]);
    const allowed = new SubagentManager("parent", { worker: async () => "Done" });
    try {
      const run = allowed.start(assignment);
      expect((await allowed.wait(run.id)).status).toBe("completed");
      setSubagentModelChain([{ provider: "free", model: "one", disabled: true }]);
      expect(() => allowed.restart(run.id)).toThrow(/All configured subagent models are disabled/);
    } finally {
      allowed.dispose();
    }

    clearSubagentModelChain();
    await expect(launch()).resolves.toBe("completed");
  });
});
