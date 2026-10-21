import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { invalidateModelLists } from "../../src/llm/model-list-cache.js";
import { nvidiaFallbackModels, resetNvidiaModelCatalogCache } from "../../src/llm/nvidia.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { collectAllModels, handleModel, handleModels } from "../../src/ui-core/commands/picker-commands.js";
import { releaseSessionModel, resetSessionModelCache } from "../../src/store/session-model.js";

const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

let modelDir: string;
const active = new Set<AppServices>();

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function setup(): AppServices {
  const services = createCompositionRoot({
    agent: { runTurn: async () => createTurnOutcome({ status: "succeeded", answer: "", steps: 0, remainingCriteria: [] }) },
    persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
  });
  active.add(services);
  services.session.setProvider("nvidia");
  return services;
}

function pickerOf(services: AppServices) {
  const overlay = services.overlay.getState();
  if (overlay.kind !== "picker") throw new Error("picker did not open");
  return overlay.request;
}

function nvidiaCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === NVIDIA_MODELS_URL).length;
}

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), "clai-model-refresh-"));
  vi.stubEnv("CLAI_SESSION_MODEL_DIR", modelDir);
  vi.stubEnv("NVIDIA_API_KEY", "nvapi-modelrefreshcommand0123456789");
  resetSessionModelCache();
  invalidateModelLists();
  resetNvidiaModelCatalogCache();
});

afterEach(async () => {
  for (const services of active) {
    services.dispose();
    await releaseSessionModel(services.session.sessionId);
  }
  active.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateModelLists();
  resetSessionModelCache();
  await rm(modelDir, { recursive: true, force: true });
});

describe("/model refresh", () => {
  it("re-fetches the list instead of using the cache, and reports it", async () => {
    let live = ["nvidia/first-model"];
    const fetchMock = vi.fn(async () => json({ data: live.map((id) => ({ id })) }));
    vi.stubGlobal("fetch", fetchMock);
    const services = setup();
    const notice = vi.spyOn(services.session, "notice");
    const toast = vi.spyOn(services.toast, "info");

    await handleModel(services, { name: "model", args: "" });
    expect(pickerOf(services).options.map((option) => option.value)).toEqual(["nvidia/first-model"]);
    services.overlay.close();
    live = ["nvidia/first-model", "nvidia/second-model"];

    await handleModel(services, { name: "model", args: "" });
    expect(pickerOf(services).options).toHaveLength(1);
    expect(nvidiaCalls(fetchMock)).toBe(1);
    services.overlay.close();

    await handleModel(services, { name: "model", args: "refresh" });
    const picker = pickerOf(services);
    expect(picker.options.map((option) => option.value)).toEqual(["nvidia/first-model", "nvidia/second-model"]);
    expect(picker.title).toBe("Models · NVIDIA NIM · live");
    expect(nvidiaCalls(fetchMock)).toBe(2);
    expect(toast).toHaveBeenLastCalledWith("refreshing NVIDIA NIM models…", expect.objectContaining({ sticky: true }));
    expect(notice).toHaveBeenLastCalledWith("info", "NVIDIA NIM · 2 models (live, refreshed)");
  });

  it("does not select a model named refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "nvidia/first-model" }] })));
    const services = setup();
    services.session.setModel("nvidia/first-model");
    await handleModel(services, { name: "model", args: "REFRESH" });
    expect(services.session.getState().model).toBe("nvidia/first-model");
    expect(pickerOf(services).options).toHaveLength(1);
  });

  it("says plainly that a built-in list is not live and shows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const services = setup();
    const notice = vi.spyOn(services.session, "notice");

    await handleModel(services, { name: "model", args: "" });
    expect(notice).toHaveBeenCalledWith(
      "warn",
      "could not refresh NVIDIA NIM models: the provider did not return a live list · showing known models",
    );
    const picker = pickerOf(services);
    expect(picker.title).toBe("Models · NVIDIA NIM");
    expect(picker.options.map((option) => option.value)).toEqual([...nvidiaFallbackModels]);
  });

  it("shows the live list straight away once the network is back, without refreshing", async () => {
    let online = false;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new Error("network down");
      return json({ data: [{ id: "nvidia/live-model" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const services = setup();

    await handleModel(services, { name: "model", args: "" });
    expect(pickerOf(services).title).toBe("Models · NVIDIA NIM");
    services.overlay.close();

    online = true;
    await handleModel(services, { name: "model", args: "" });
    expect(pickerOf(services).title).toBe("Models · NVIDIA NIM · live");
    expect(pickerOf(services).options.map((option) => option.value)).toEqual(["nvidia/live-model"]);
  });
});

describe("/models refresh", () => {
  function allProvidersFetch(live: () => string[]) {
    return vi.fn(async (input: unknown) => {
      if (String(input) === NVIDIA_MODELS_URL) return json({ data: live().map((id) => ({ id })) });
      return new Response("unavailable", { status: 503 });
    });
  }

  it("re-fetches every configured provider only when asked to", async () => {
    let live = ["nvidia/first-model"];
    const fetchMock = allProvidersFetch(() => live);
    vi.stubGlobal("fetch", fetchMock);

    const first = await collectAllModels();
    expect(first.entries.filter((entry) => entry.provider === "nvidia").map((entry) => entry.model)).toEqual(["nvidia/first-model"]);
    live = ["nvidia/first-model", "nvidia/second-model"];

    const cached = await collectAllModels();
    expect(cached.entries.filter((entry) => entry.provider === "nvidia")).toHaveLength(1);
    expect(nvidiaCalls(fetchMock)).toBe(1);

    const refreshed = await collectAllModels({ refresh: true });
    expect(refreshed.entries.filter((entry) => entry.provider === "nvidia").map((entry) => entry.model)).toEqual([
      "nvidia/first-model",
      "nvidia/second-model",
    ]);
    expect(nvidiaCalls(fetchMock)).toBe(2);
  });

  it("refreshes before applying a filter and says so", async () => {
    let live = ["nvidia/first-model"];
    vi.stubGlobal("fetch", allProvidersFetch(() => live));
    const services = setup();
    const toast = vi.spyOn(services.toast, "info");

    await handleModels(services, { name: "models", args: "" });
    services.overlay.close();
    live = ["nvidia/first-model", "nvidia/second-model"];

    await handleModels(services, { name: "models", args: "refresh nvidia/second-model" });
    expect(toast).toHaveBeenLastCalledWith("refreshing models from all providers…", expect.objectContaining({ sticky: true }));
    expect(services.session.getState().model).toBe("nvidia/second-model");
    expect(services.session.getState().provider).toBe("nvidia");
  });

  it("opens the full catalogue after a plain refresh", async () => {
    vi.stubGlobal("fetch", allProvidersFetch(() => ["nvidia/first-model"]));
    const services = setup();
    const notice = vi.spyOn(services.session, "notice");

    await handleModels(services, { name: "models", args: "refresh" });
    expect(notice).toHaveBeenCalledWith("info", expect.stringMatching(/ · refreshed$/));
    expect(pickerOf(services).options.some((option) => option.label.endsWith("nvidia/first-model"))).toBe(true);
  });

  it("still treats other text as a filter", async () => {
    vi.stubGlobal("fetch", allProvidersFetch(() => ["nvidia/first-model"]));
    const services = setup();
    const toast = vi.spyOn(services.toast, "info");

    await handleModels(services, { name: "models", args: "nvidia/first-model" });
    expect(toast).toHaveBeenLastCalledWith("collecting models from all providers…", expect.anything());
    expect(services.session.getState().model).toBe("nvidia/first-model");
  });
});
