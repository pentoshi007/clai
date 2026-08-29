import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FREE_CATALOG_MODEL = "free-2/from-live-catalog";

vi.mock("../../src/llm/free-default-model.js", () => ({
  resolveFreeDefaultModel: async () => FREE_CATALOG_MODEL,
  pickFreeModel: () => FREE_CATALOG_MODEL,
}));

import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  clearSessionModel,
  getSessionModelPath,
  loadModelForSession,
  loadSessionModelBinding,
  releaseSessionModel,
  resetSessionModelCache,
  saveSessionModel,
  seedSessionModel,
} from "../../src/store/session-model.js";
import { getConfig, getProviderModel } from "../../src/store/config.js";

const SESSION_A = "sess-aaaa1111";
const SESSION_B = "sess-bbbb2222";

let modelDir: string;

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), "clai-session-model-"));
  process.env.CLAI_SESSION_MODEL_DIR = modelDir;
  resetSessionModelCache();
});

afterEach(async () => {
  resetSessionModelCache();
  delete process.env.CLAI_SESSION_MODEL_DIR;
  await rm(modelDir, { recursive: true, force: true });
});

describe("session model binding", () => {
  it("binds a provider/model to the session that set it", async () => {
    await saveSessionModel(SESSION_A, { provider: "nvidia", model: "openai/gpt-oss-20b" });
    const binding = await loadSessionModelBinding(SESSION_A);
    expect(binding).toEqual({ provider: "nvidia", model: "openai/gpt-oss-20b" });
  });

  it("falls back to the global default for an unbound session", async () => {
    const config = getConfig();
    const resolved = await loadModelForSession(SESSION_B);
    expect(resolved.provider).toBe(config.defaultProvider);
    expect(resolved.model.length).toBeGreaterThan(0);
    expect(await loadSessionModelBinding(SESSION_B)).toBeUndefined();
  });

  it("keeps two sessions isolated from each other", async () => {
    await saveSessionModel(SESSION_A, { provider: "nvidia", model: "model-a" });
    await saveSessionModel(SESSION_B, { provider: "gemini", model: "model-b" });
    expect(await loadSessionModelBinding(SESSION_A)).toEqual({
      provider: "nvidia",
      model: "model-a",
    });
    expect(await loadSessionModelBinding(SESSION_B)).toEqual({
      provider: "gemini",
      model: "model-b",
    });
  });

  it("keeps rapid writes ordered for one session", async () => {
    const first = saveSessionModel(SESSION_A, {
      provider: "nvidia",
      model: "first-model",
    });
    const second = saveSessionModel(SESSION_A, {
      provider: "gemini",
      model: "second-model",
    });
    await Promise.all([first, second]);
    resetSessionModelCache();
    expect(await loadSessionModelBinding(SESSION_A)).toEqual({
      provider: "gemini",
      model: "second-model",
    });
  });

  it("survives a cache reset by reading the binding from disk", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "disk-model" });
    resetSessionModelCache();
    expect(await loadSessionModelBinding(SESSION_A)).toEqual({
      provider: "gemini",
      model: "disk-model",
    });
  });

  it("writes one envelope file per session id", async () => {
    await saveSessionModel(SESSION_A, { provider: "nvidia", model: "openai/gpt-oss-20b" });
    const raw = JSON.parse(await readFile(getSessionModelPath(SESSION_A), "utf8")) as {
      version: number;
      sessionId: string;
      binding: { provider?: string; model?: string };
    };
    expect(raw.version).toBe(1);
    expect(raw.sessionId).toBe(SESSION_A);
    expect(raw.binding).toEqual({ provider: "nvidia", model: "openai/gpt-oss-20b" });
  });

  it("keeps a path-hostile session id inside the model directory", () => {
    const path = getSessionModelPath("../../escape/../id with spaces");
    expect(dirname(resolve(path))).toBe(resolve(modelDir));
    expect(basename(path)).not.toContain("/");
  });

  it("returns undefined for a missing file (back-compat)", async () => {
    expect(await loadSessionModelBinding("sess-never-saved")).toBeUndefined();
  });

  it("ignores a corrupt binding file instead of throwing", async () => {
    await saveSessionModel(SESSION_A, { provider: "nvidia", model: "m" });
    resetSessionModelCache();
    await writeFile(getSessionModelPath(SESSION_A), "{ not json", "utf8");
    resetSessionModelCache();
    await expect(loadSessionModelBinding(SESSION_A)).resolves.toBeUndefined();
  });
});

describe("session model release + clear", () => {
  it("re-inherits the global default after the binding is released", async () => {
    const config = getConfig();
    await saveSessionModel(SESSION_A, { provider: "nvidia", model: "openai/gpt-oss-20b" });
    expect(await loadSessionModelBinding(SESSION_A)).toBeDefined();

    await releaseSessionModel(SESSION_A);

    expect(await loadSessionModelBinding(SESSION_A)).toBeUndefined();
    expect((await loadModelForSession(SESSION_A)).provider).toBe(config.defaultProvider);
  });

  it("orders release after a pending save", async () => {
    const pendingSave = saveSessionModel(SESSION_A, {
      provider: "nvidia",
      model: "pending-model",
    });
    const pendingRelease = releaseSessionModel(SESSION_A);
    await Promise.all([pendingSave, pendingRelease]);
    resetSessionModelCache();
    expect(await loadSessionModelBinding(SESSION_A)).toBeUndefined();
    await expect(readFile(getSessionModelPath(SESSION_A), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("is safe to release a session that never had a binding", async () => {
    await expect(releaseSessionModel("sess-never-bound")).resolves.toBeUndefined();
  });

  it("clearing reverts the session to the global default", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "m" });
    await clearSessionModel(SESSION_A);
    expect(await loadSessionModelBinding(SESSION_A)).toBeUndefined();
  });
});

describe("seedSessionModel", () => {
  it("prefers the stored binding over the fallback", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "bound-model" });
    const seeded = await seedSessionModel(SESSION_A, {
      provider: "nvidia",
      model: "fallback-model",
    });
    expect(seeded).toEqual({ provider: "gemini", model: "bound-model" });
  });

  it("uses the fallback when the session is unbound", async () => {
    const seeded = await seedSessionModel(SESSION_B, {
      provider: "nvidia",
      model: "fallback-model",
    });
    expect(seeded).toEqual({ provider: "nvidia", model: "fallback-model" });
  });

  it("uses the bound provider model when only a provider was stored", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini" });
    const seeded = await seedSessionModel(SESSION_A, {
      provider: "nvidia",
      model: "nvidia-fallback-model",
    });
    expect(seeded).toEqual({
      provider: "gemini",
      model: getProviderModel("gemini"),
    });
  });

  it("starts a brand-new session on the model last used in a past session", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "past-model" });
    const seeded = await seedSessionModel("sess-brand-new", {
      provider: undefined,
      model: undefined,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "gemini", model: "past-model" });
  });

  it("uses the newest past session when several sessions have bindings", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "older-model" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saveSessionModel(SESSION_B, { provider: "nvidia", model: "newest-model" });
    const seeded = await seedSessionModel("sess-brand-new-2", {
      provider: undefined,
      model: undefined,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "nvidia", model: "newest-model" });
  });

  it("fills in the provider default when a past session stored only a provider", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini" });
    const seeded = await seedSessionModel("sess-brand-new-3", {
      provider: undefined,
      model: undefined,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "gemini", model: getProviderModel("gemini") });
  });

  it("lets an explicit provider choice win over the last used model", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "past-model" });
    const seeded = await seedSessionModel("sess-brand-new-4", {
      provider: "nvidia",
      model: undefined,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "nvidia", model: getProviderModel("nvidia") });
  });

  it("lets an explicit model flag win while keeping the inherited provider", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "past-model" });
    const seeded = await seedSessionModel("sess-brand-new-5", {
      provider: undefined,
      model: "explicitly/requested",
      modelExplicit: true,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "gemini", model: "explicitly/requested" });
  });

  it("never pastes a caller-derived model onto an inherited provider", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "past-model" });
    const seeded = await seedSessionModel("sess-brand-new-6", {
      provider: undefined,
      model: "moonshotai/kimi-k3",
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "gemini", model: "past-model" });
  });

  it("never inherits another session's model when inheritance is not requested", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "past-model" });
    const seeded = await seedSessionModel("sess-existing-without-binding", {
      provider: undefined,
      model: undefined,
    });
    expect(seeded).toEqual({ provider: undefined, model: undefined });
  });

  it("keeps a session's own bound model even when another session changed later", async () => {
    await saveSessionModel(SESSION_A, { provider: "gemini", model: "mine" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saveSessionModel(SESSION_B, { provider: "nvidia", model: "theirs" });
    const seeded = await seedSessionModel(SESSION_A, {
      provider: undefined,
      model: undefined,
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "gemini", model: "mine" });
  });

  it("uses a free catalog model when no past chat exists at all", async () => {
    const seeded = await seedSessionModel("sess-first-ever", {
      provider: undefined,
      model: "moonshotai/kimi-k3",
      inheritLastUsed: true,
    });
    expect(seeded).toEqual({ provider: "free", model: FREE_CATALOG_MODEL });
  });
});
