import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderApi } from "../../src/llm/custom-providers.js";
import { addCustomProviderFlow } from "../../src/ui-core/commands/pickers/custom-provider.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";

const state = vi.hoisted(() => ({
  add: vi.fn(), setModel: vi.fn(), setDefault: vi.fn(), saveKey: vi.fn(async () => "fallback" as const),
}));
vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual, getCustomProviders: () => [], addCustomProvider: state.add,
    setProviderModel: state.setModel, setDefaultProvider: state.setDefault,
  };
});
vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return { ...actual, setProviderSecret: state.saveKey };
});

const active = new Set<AppServices>();
afterEach(() => {
  for (const services of active) services.dispose();
  active.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function setup(api: CustomProviderApi, manual = "manual-model", cancelModel = false) {
  const services = createCompositionRoot({
    agent: { runTurn: async () => createTurnOutcome({ status: "succeeded", answer: "", steps: 0, remainingCriteria: [] }) },
    persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
  });
  active.add(services);
  const answers = ["fixture-custom", "Fixture Gateway", "https://fixture.example/v1", "fixture-custom-key", manual];
  const titles: string[] = [];
  const secret = vi.spyOn(services.overlay, "openSecret").mockImplementation(async (request) => {
    titles.push(request.title ?? "");
    return answers.shift();
  });
  const picker = vi.spyOn(services.overlay, "openPicker").mockImplementation((request, select) => {
    titles.push(request.title ?? "");
    if (request.title?.includes("API type")) select?.(api);
    else if (cancelModel) return false;
    else select?.("live-model");
    return true;
  });
  vi.spyOn(services.session, "setProvider").mockImplementation(() => {});
  vi.spyOn(services.session, "setModel").mockImplementation(() => {});
  const notice = vi.spyOn(services.session, "notice");
  const dismiss = vi.spyOn(services.toast, "dismiss");
  return { services, secret, picker, notice, dismiss, titles };
}

describe("shared custom-provider onboarding discovery", () => {
  it.each(["chat-completions", "responses", "anthropic-messages"] as const)("shows discovered %s models before asking for a manual model", async (api) => {
    const flow = setup(api);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(state.add).not.toHaveBeenCalled();
      expect(state.saveKey).not.toHaveBeenCalled();
      const headers = new Headers(init?.headers);
      expect(headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization")).toBe(api === "anthropic-messages" ? "fixture-custom-key" : "Bearer fixture-custom-key");
      return Response.json({ data: [{ id: "live-model" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await addCustomProviderFlow(flow.services);
    expect(flow.secret).toHaveBeenCalledTimes(4);
    expect(flow.titles.at(-1)).toBe("Models · Fixture Gateway · live");
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "live-model", api }));
    expect(state.saveKey).toHaveBeenCalledWith("fixture-custom", "fixture-custom-key");
    expect(flow.dismiss).toHaveBeenCalledTimes(1);
  });

  it("explains a failed catalog request, redacts credentials, and retains manual fallback", async () => {
    const flow = setup("chat-completions");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Rejected fixture-custom-key" } }, { status: 401 })));
    await addCustomProviderFlow(flow.services);
    expect(flow.notice).toHaveBeenCalledWith("warn", expect.stringContaining("[redacted]"));
    expect(flow.notice.mock.calls.flat().join(" ")).not.toContain("fixture-custom-key");
    expect(flow.secret).toHaveBeenCalledTimes(5);
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "manual-model" }));
    expect(flow.dismiss).toHaveBeenCalledTimes(1);
  });

  it("retains manual entry for a valid empty catalog", async () => {
    const flow = setup("responses");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    await addCustomProviderFlow(flow.services);
    expect(flow.secret).toHaveBeenCalledTimes(5);
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "manual-model" }));
  });

  it("does not save a provider or key when model selection is cancelled", async () => {
    const flow = setup("chat-completions", "", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "live-model" }] })));
    await addCustomProviderFlow(flow.services);
    expect(state.add).not.toHaveBeenCalled();
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(flow.dismiss).toHaveBeenCalledTimes(1);
  });
});

it("falls back cleanly after the discovery deadline", async () => {
  const flow = setup("responses");
  const signal = AbortSignal.abort(new DOMException("Discovery timed out", "TimeoutError"));
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
  vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return Response.json({ data: [] });
  }));
  await addCustomProviderFlow(flow.services);
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(flow.notice).toHaveBeenCalledWith("warn", expect.stringContaining("timed out"));
  expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: "manual-model" }));
  expect(flow.dismiss).toHaveBeenCalledTimes(1);
});
