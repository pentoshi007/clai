import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSession, saveSession, upsertSession } from "../../src/store/history.js";
import {
  loadSessionModelBinding,
  resetSessionModelCache,
  saveSessionModel,
} from "../../src/store/session-model.js";
import { getConfig, setThinking } from "../../src/store/config.js";
import { clearActiveSessionWorkspace } from "../../src/store/session-workspace.js";
import { applySessionResume } from "../../src/ui-core/bootstrap/session-resume.js";
import type { ChatMessage } from "../../src/types.js";

const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
  "CLAI_SESSION_MODEL_DIR",
] as const;

let dataDir: string;
let originalEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-history-thinking-"));
  process.env.CLAI_DATA_DIR = dataDir;
  process.env.CLAI_HISTORY_DIR = dataDir;
  process.env.CLAI_CONFIG_DIR = dataDir;
  process.env.CLAI_PLAN_DIR = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dataDir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dataDir, "jobs");
  process.env.CLAI_SESSION_MODEL_DIR = join(dataDir, "session-models");
  resetSessionModelCache();
  clearActiveSessionWorkspace();
});

afterEach(async () => {
  clearActiveSessionWorkspace();
  resetSessionModelCache();
  for (const key of dataEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(dataDir, { recursive: true, force: true });
});

const MESSAGES: ChatMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

function stubServices() {
  const loaded: unknown[] = [];
  return {
    services: {
      plan: {
        clear: () => undefined,
        load: async () => undefined,
      },
      session: {
        loadHistory: (...args: unknown[]) => {
          loaded.push(args);
        },
        spool: { replace: () => undefined },
        setPlanApproved: () => undefined,
      },
      transcript: {
        hydrate: () => undefined,
      },
    } as never,
    loaded,
  };
}

describe("per-session thinking", () => {
  it("persists and restores thinking on the history record", async () => {
    const record = await saveSession(
      MESSAGES,
      "with thinking",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        provider: "nvidia",
        model: "openai/gpt-oss-20b",
        thinking: { enabled: true, effort: "high" },
      },
    );
    expect(record.thinking).toEqual({ enabled: true, effort: "high" });

    const loaded = await getSession(record.id);
    expect(loaded?.thinking).toEqual({ enabled: true, effort: "high" });
  });

  it("loads an older record with no thinking as undefined", async () => {
    const record = await saveSession(MESSAGES, "legacy");
    const loaded = await getSession(record.id);
    expect(loaded).toBeDefined();
    expect(loaded?.thinking).toBeUndefined();
  });

  it("preserves existing thinking when a later upsert omits it", async () => {
    const id = "sess-upsert-thinking";
    await upsertSession(
      id,
      MESSAGES,
      "first",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "gemini", model: "gemini-3.5-flash", thinking: { enabled: true, effort: "low" } },
    );
    await upsertSession(id, [...MESSAGES, { role: "user", content: "again" }], "second");

    const loaded = await getSession(id);
    expect(loaded?.thinking).toEqual({ enabled: true, effort: "low" });
  });

  it("binds thinking to the session that set it", async () => {
    await saveSessionModel("sess-think-a", {
      provider: "nvidia",
      model: "model-a",
      thinking: { enabled: true, effort: "xhigh" },
    });
    const binding = await loadSessionModelBinding("sess-think-a");
    expect(binding?.thinking).toEqual({ enabled: true, effort: "xhigh" });
  });

  it("rejects malformed thinking in stored bindings", async () => {
    await saveSessionModel("sess-think-bad", {
      provider: "nvidia",
      thinking: { enabled: true, effort: "ultra" } as never,
    });
    const binding = await loadSessionModelBinding("sess-think-bad");
    expect(binding?.thinking).toBeUndefined();
  });

  it("restores the resumed session thinking instead of keeping the latest", async () => {
    setThinking({ enabled: true, effort: "max" });
    const record = await saveSession(
      MESSAGES,
      "earlier session",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        provider: "nvidia",
        model: "openai/gpt-oss-20b",
        thinking: { enabled: true, effort: "low" },
      },
    );
    const stored = await getSession(record.id);
    expect(stored).toBeDefined();

    const { services } = stubServices();
    await applySessionResume(services, stored!);
    expect(getConfig().thinking).toEqual({ enabled: true, effort: "low" });
  });

  it("leaves thinking alone when the resumed session never stored any", async () => {
    setThinking({ enabled: false, effort: "medium" });
    const record = await saveSession(MESSAGES, "legacy session");
    const stored = await getSession(record.id);
    expect(stored).toBeDefined();

    const { services } = stubServices();
    await applySessionResume(services, stored!);
    expect(getConfig().thinking).toEqual({ enabled: false, effort: "medium" });
  });

  it("keeps each session effort across a full switch round-trip", async () => {
    const { services } = stubServices();
    setThinking({ enabled: true, effort: "xhigh" });
    const recordA = await saveSession(
      MESSAGES,
      "session a",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        provider: "nvidia",
        model: "openai/gpt-oss-20b",
        thinking: { ...getConfig().thinking },
      },
    );
    setThinking({ enabled: true, effort: "high" });
    const recordB = await saveSession(
      MESSAGES,
      "session b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        provider: "gemini",
        model: "gemini-3.5-flash",
        thinking: { ...getConfig().thinking },
      },
    );

    await applySessionResume(services, (await getSession(recordA.id))!);
    expect(getConfig().thinking).toEqual({ enabled: true, effort: "xhigh" });

    await applySessionResume(services, (await getSession(recordB.id))!);
    expect(getConfig().thinking).toEqual({ enabled: true, effort: "high" });

    await applySessionResume(services, (await getSession(recordA.id))!);
    expect(getConfig().thinking).toEqual({ enabled: true, effort: "xhigh" });
  });
});
