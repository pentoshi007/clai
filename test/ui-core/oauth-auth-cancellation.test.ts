import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { runClineAuthForUI, runCodexAuthForUI } from "../../src/ui-core/commands/key-commands.js";

const h = vi.hoisted(() => ({
  startCline: vi.fn(), pollCline: vi.fn(), startCodex: vi.fn(), pollCodex: vi.fn(),
  startBrowser: vi.fn(), browser: vi.fn(), closeBrowser: vi.fn(),
}));
vi.mock("../../src/llm/cline-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/cline-auth.js")>(),
  startClineDeviceAuth: h.startCline, pollClineDeviceAuth: h.pollCline,
}));
vi.mock("../../src/llm/codex-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/codex-auth.js")>(),
  startCodexDeviceAuth: h.startCodex, pollCodexDeviceAuth: h.pollCodex, startCodexBrowserAuth: h.startBrowser,
}));
vi.mock("../../src/mcp/auth/loopback.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/mcp/auth/loopback.js")>(), openSystemBrowser: h.browser,
}));
const active: AppServices[] = [];
function services(): AppServices {
  const app = createCompositionRoot({ provider: "free", noHistory: true });
  active.push(app); return app;
}
function pending(_start: object, options: { signal: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
}
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  for (const name of ["CLAI_NO_BROWSER", "DISPLAY", "WAYLAND_DISPLAY", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT"]) vi.stubEnv(name, "");
  vi.stubEnv("BROWSER", "");
  h.browser.mockResolvedValue(undefined);
  h.startCline.mockResolvedValue({ verificationUrl: "https://authkit.cline.bot/device", userCode: "FIXTURE" });
  h.startCodex.mockResolvedValue({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "FIXTURE" });
  h.pollCline.mockImplementation(pending); h.pollCodex.mockImplementation(pending);
  h.startBrowser.mockResolvedValue({
    url: "https://auth.openai.com/oauth/authorize", close: h.closeBrowser,
    waitForCredential: () => new Promise<never>(() => {}),
  });
});
afterEach(() => {
  for (const app of active.splice(0)) app.dispose();
  vi.unstubAllEnvs();
});

describe("shared OAuth method selection and cancellation", () => {
  it.each([false, true])("selects the ChatGPT method default for desktop=%s", async (desktop) => {
    vi.stubEnv("DISPLAY", desktop ? ":1" : "");
    vi.stubEnv("SSH_CONNECTION", desktop ? "" : "fixture ssh");
    const app = services(); const result = runCodexAuthForUI(app);
    const state = app.overlay.getState();
    if (state.kind !== "picker") throw new Error("missing method picker");
    expect(state.request.options[0]?.value).toBe(desktop ? "browser" : "headless");
    app.overlay.close(); await expect(result).resolves.toBeUndefined();
    expect(app.focus.activeContext()).toBe("composer");
    expect(h.startCodex).not.toHaveBeenCalled(); expect(h.startBrowser).not.toHaveBeenCalled();
  });

  it("does not launch a local browser for ChatGPT over SSH and aborts polling", async () => {
    vi.stubEnv("SSH_CONNECTION", "fixture ssh"); vi.stubEnv("DISPLAY", ":1");
    const app = services(); const result = runCodexAuthForUI(app);
    app.overlay.selectPicker("headless");
    await vi.waitFor(() => expect(h.pollCodex).toHaveBeenCalledOnce());
    const options = h.pollCodex.mock.calls[0]?.[1] as { signal: AbortSignal };
    app.overlay.close(); await expect(result).resolves.toBeUndefined();
    expect(options.signal.aborted).toBe(true); expect(h.browser).not.toHaveBeenCalled();
    expect(app.focus.activeContext()).toBe("composer");
  });

  it("closes the ChatGPT loopback listener when its browser pager is cancelled", async () => {
    const app = services(); const result = runCodexAuthForUI(app);
    app.overlay.selectPicker("browser");
    await vi.waitFor(() => expect(app.overlay.getState().kind).toBe("pager"));
    app.overlay.close(); await expect(result).resolves.toBeUndefined();
    expect(h.closeBrowser).toHaveBeenCalledOnce();
  });

  it.each([false, true])("Cline automatically uses browser only on desktop=%s", async (desktop) => {
    vi.stubEnv("DISPLAY", desktop ? ":1" : "");
    if (!desktop) vi.stubEnv("SSH_CONNECTION", "fixture ssh");
    const app = services(); const result = runClineAuthForUI(app);
    await vi.waitFor(() => expect(h.pollCline).toHaveBeenCalledOnce());
    const options = h.pollCline.mock.calls[0]?.[1] as { signal: AbortSignal };
    app.overlay.close(); await expect(result).resolves.toBeUndefined();
    expect(options.signal.aborted).toBe(true);
    expect(h.browser).toHaveBeenCalledTimes(desktop ? 1 : 0);
    expect(app.focus.activeContext()).toBe("composer");
  });
});
