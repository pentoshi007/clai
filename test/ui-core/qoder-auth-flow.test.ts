import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { runQoderAuthForUI, openQoderKeysFlow } from "../../src/ui-core/commands/keys/qoder.js";
import { QoderAuthError } from "../../src/llm/qoder/qoder-auth.js";
import { encodeQoderCredential, parseQoderCredential, type QoderCredential } from "../../src/llm/qoder/qoder-credential.js";
import { getProvider } from "../../src/llm/router.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";

const h = vi.hoisted(() => ({
  keys: [] as ProviderKeySlot[], activeIndex: 0,
  start: vi.fn(), poll: vi.fn(), pat: vi.fn(), import: vi.fn(), browser: vi.fn(), refresh: vi.fn(),
  append: vi.fn(), replace: vi.fn(), save: vi.fn(), reset: vi.fn(), enable: vi.fn(), activate: vi.fn(),
}));

vi.mock("../../src/llm/qoder/qoder-login.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/qoder/qoder-login.js")>(),
  startQoderDeviceAuth: h.start, pollQoderDeviceAuth: h.poll,
  loginQoderWithPat: h.pat, importQoderAccount: h.import,
}));
vi.mock("../../src/llm/qoder/qoder-refresh.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/qoder/qoder-refresh.js")>(),
  refreshQoderAccount: h.refresh,
}));
vi.mock("../../src/mcp/auth/loopback.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/mcp/auth/loopback.js")>(), openSystemBrowser: h.browser,
}));
vi.mock("../../src/store/session-model.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/session-model.js")>(), saveSessionModel: vi.fn(async () => {}),
}));
vi.mock("../../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/keys.js")>(),
  envValue: () => undefined,
  getProviderKeys: async () => ({ keys: h.keys.map((key) => ({ ...key })), activeIndex: h.activeIndex, source: "fallback" as const }),
  getProviderSecret: async () => ({ value: h.keys.find((key) => !key.disabled)?.value }),
  appendProviderKey: h.append, replaceProviderKey: h.replace, setProviderKeys: h.save,
  unsetProviderSecret: h.reset, setProviderKeyDisabled: h.enable, markProviderKeySuccess: h.activate,
}));

const servicesInUse: AppServices[] = [];
function services(): AppServices {
  const result = createCompositionRoot({
    provider: "free", noHistory: true,
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30 }),
  });
  attachCommandHandlers(result);
  servicesInUse.push(result);
  return result;
}

function credential(uid = "account-a"): QoderCredential {
  return {
    uid, email: `${uid}@test.invalid`, accessToken: `fixture-access-${uid}`,
    refreshToken: `fixture-refresh-${uid}`, expireTime: 2_147_483_647,
    encryptUserInfo: "fixture-signer", key: "fixture-key", machineId: "fixture-machine", machineToken: "fixture-token",
  };
}
function addSlot(uid: string, disabled = false): ProviderKeySlot {
  const slot = { id: uid, value: encodeQoderCredential(credential(uid)), createdAt: 1, disabled };
  h.keys.push(slot);
  return slot;
}
async function waitOverlay(app: AppServices, kind: string): Promise<void> {
  await vi.waitFor(() => expect(app.overlay.getState().kind).toBe(kind));
}
function cancelOverlay(app: AppServices): void {
  if (!app.overlay.cancelBlockingPrompt()) app.overlay.close();
}
function pendingLogin(signal: AbortSignal): Promise<QoderCredential> {
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
async function choosePat(app: AppServices): Promise<void> {
  await waitOverlay(app, "picker");
  app.overlay.selectPicker("pat");
  await waitOverlay(app, "secret");
  app.overlay.answerSecret("fixture-pat");
}

beforeEach(() => {
  h.keys = []; h.activeIndex = 0;
  for (const fn of Object.values(h)) if (typeof fn === "function") fn.mockReset();
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "CI"]) vi.stubEnv(name, "");
  h.start.mockResolvedValue({ authUrl: "https://qoder.com/device/selectAccounts?challenge=fixture" });
  h.poll.mockResolvedValue(credential()); h.pat.mockResolvedValue(credential()); h.import.mockResolvedValue(credential());
  h.browser.mockResolvedValue(undefined); h.refresh.mockResolvedValue(credential());
  h.append.mockImplementation(async (_provider: string, value: string) => {
    h.keys.push({ id: `slot-${h.keys.length}`, value, createdAt: 2 }); return "fallback";
  });
  h.replace.mockImplementation(async (_provider: string, old: string, value: string) => {
    const slot = h.keys.find((key) => key.value === old);
    if (!slot) return false;
    slot.value = value; return true;
  });
  h.save.mockImplementation(async (_provider: string, values: string[], active: number, disabled: string[] = []) => {
    h.keys = values.map((value) => ({
      ...(h.keys.find((key) => key.value === value) ?? { id: "new-slot", createdAt: 2 }),
      value, disabled: disabled.includes(value),
    }));
    h.activeIndex = active; return "fallback";
  });
  h.reset.mockImplementation(async () => { h.keys = []; });
  h.enable.mockImplementation(async (_provider: string, value: string, disabled: boolean) => {
    const slot = h.keys.find((key) => key.value === value);
    if (slot) slot.disabled = disabled;
    return Boolean(slot);
  });
  h.activate.mockImplementation(async (_provider: string, index: number) => { h.activeIndex = index; });
  vi.spyOn(getProvider("qoder"), "listModels").mockResolvedValue(["qfmodel:free"]);
});
afterEach(() => {
  for (const app of servicesInUse.splice(0)) app.dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe("Qoder shared UI sign-in", () => {
  it.each([false, true])("prioritizes the environment-appropriate method (desktop=%s)", async (desktop) => {
    vi.stubEnv("DISPLAY", desktop ? ":1" : "");
    const app = services();
    const result = runQoderAuthForUI(app);
    const state = app.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind !== "picker") throw new Error("missing auth picker");
    expect(state.request.options.map((option) => option.value)).toEqual(desktop
      ? ["browser", "headless", "pat", "import"] : ["headless", "browser", "pat", "import"]);
    cancelOverlay(app);
    await expect(result).resolves.toBeUndefined();
    expect(app.focus.activeContext()).toBe("composer");
  });

  it("keeps SSH headless even with a forwarded display", async () => {
    vi.stubEnv("DISPLAY", ":1"); vi.stubEnv("SSH_CONNECTION", "fixture ssh");
    const app = services(); const result = runQoderAuthForUI(app);
    const state = app.overlay.getState();
    if (state.kind !== "picker") throw new Error("missing auth picker");
    expect(state.request.options[0]?.value).toBe("headless");
    cancelOverlay(app); await result;
  });

  it("uses a masked secret prompt for PAT without echoing the token", async () => {
    const app = services(); const notice = vi.spyOn(app.session, "notice");
    const result = runQoderAuthForUI(app);
    app.overlay.selectPicker("pat"); await waitOverlay(app, "secret");
    const state = app.overlay.getState();
    if (state.kind !== "secret") throw new Error("missing secret prompt");
    expect(state.request.reveal).not.toBe(true);
    expect(state.request.prompt).toContain("https://qoder.com/account/integrations");
    app.overlay.answerSecret("fixture-pat"); await expect(result).resolves.toEqual(credential());
    expect(h.pat).toHaveBeenCalledWith("fixture-pat", { signal: expect.any(AbortSignal) });
    expect(JSON.stringify(notice.mock.calls)).not.toContain("fixture-pat");
    expect(app.overlay.getState().kind).toBe("none");
  });

  it("returns from a cancelled device pager to PAT and never opens a headless browser", async () => {
    h.poll.mockImplementation((_start, options: { signal: AbortSignal }) => pendingLogin(options.signal));
    const app = services(); const result = runQoderAuthForUI(app);
    app.overlay.selectPicker("headless"); await waitOverlay(app, "pager");
    const state = app.overlay.getState();
    if (state.kind !== "pager") throw new Error("missing auth pager");
    expect(state.body).toContain("https://qoder.com/device/selectAccounts");
    await vi.waitFor(() => expect(h.poll).toHaveBeenCalledOnce());
    const options = h.poll.mock.calls[0]?.[1] as { signal: AbortSignal };
    cancelOverlay(app); await waitOverlay(app, "picker");
    expect(options.signal.aborted).toBe(true); expect(h.browser).not.toHaveBeenCalled();
    await choosePat(app); await expect(result).resolves.toEqual(credential());
  });

  it("keeps the link and PAT fallback usable when browser launch fails", async () => {
    h.browser.mockRejectedValue(new Error("no GUI"));
    h.poll.mockImplementation((_start, options: { signal: AbortSignal }) => pendingLogin(options.signal));
    const app = services(); const notice = vi.spyOn(app.session, "notice");
    const result = runQoderAuthForUI(app);
    app.overlay.selectPicker("browser"); await waitOverlay(app, "pager");
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("info", expect.stringContaining("Could not open a browser")));
    cancelOverlay(app); await choosePat(app); await expect(result).resolves.toEqual(credential());
  });

  it("rejects a late import result after pager cancellation", async () => {
    let complete: (data: QoderCredential) => void = () => {};
    h.import.mockImplementation(() => new Promise<QoderCredential>((resolve) => { complete = resolve; }));
    const app = services(); const result = runQoderAuthForUI(app);
    app.overlay.selectPicker("import"); await waitOverlay(app, "pager");
    cancelOverlay(app); complete(credential()); await waitOverlay(app, "picker");
    cancelOverlay(app); await expect(result).resolves.toBeUndefined();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("returns to method selection after exchange failure or secret cancellation", async () => {
    h.pat.mockRejectedValue(new QoderAuthError("PAT rejected", 401));
    const app = services(); const result = runQoderAuthForUI(app);
    app.overlay.selectPicker("pat"); await waitOverlay(app, "secret");
    cancelOverlay(app); await waitOverlay(app, "picker");
    await choosePat(app); await waitOverlay(app, "picker");
    cancelOverlay(app); await expect(result).resolves.toBeUndefined();
    expect(app.focus.activeContext()).toBe("composer");
  });

  it.each(["provider", "providers"])("/%s authenticates before activation", async (name) => {
    const app = services();
    expect(await app.commands.dispatch({ name, args: "qoder" })).toBe(true);
    await waitOverlay(app, "picker"); expect(app.session.getState().provider).toBe("free");
    await choosePat(app);
    await vi.waitFor(() => expect(app.session.getState().provider).toBe("qoder"));
    expect(parseQoderCredential(h.keys[0]!.value).uid).toBe("account-a");
    expect(h.enable).toHaveBeenCalledWith("qoder", h.keys[0]!.value, false);
    expect(h.activate).toHaveBeenCalledWith("qoder", 0);
  });

  it("does not switch providers when sign-in is cancelled or storage fails", async () => {
    const app = services();
    await app.commands.dispatch({ name: "providers", args: "qoder" }); await waitOverlay(app, "picker");
    cancelOverlay(app); await vi.waitFor(() => expect(app.focus.activeContext()).toBe("composer"));
    expect(app.session.getState().provider).toBe("free");
    h.append.mockRejectedValue(new Error("storage unavailable"));
    const notice = vi.spyOn(app.session, "notice");
    await app.commands.dispatch({ name: "providers", args: "qoder" }); await choosePat(app);
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("Could not save Qoder sign-in")));
    expect(app.session.getState().provider).toBe("free");
  });
});

describe("Qoder /set shared account controls", () => {
  it("saves the chosen active account, disabled flags, and removed rows", async () => {
    addSlot("account-a"); addSlot("account-b"); addSlot("account-c");
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor");
    const state = app.overlay.getState();
    if (state.kind !== "keys-editor") throw new Error("missing account editor");
    expect(state.request).toMatchObject({ heading: "QODER ACCOUNTS", refreshable: true, addViaPicker: true });
    expect(JSON.stringify(state.request)).not.toContain("fixture-access");
    app.overlay.answerKeys({ action: "save", rows: [
      { slotId: "account-a", value: "account-a@test.invalid", disabled: true },
      { slotId: "account-c", value: "", disabled: false },
    ], activeIndex: 1 });
    await result;
    expect(h.keys.map((key) => key.id)).toEqual(["account-a", "account-c"]);
    expect(h.keys[0]?.disabled).toBe(true); expect(h.keys[1]?.disabled).toBe(false);
    expect(h.activeIndex).toBe(1);
  });

  it("commits draft removal before adding a distinct account", async () => {
    addSlot("account-a"); const sibling = addSlot("account-b", true);
    h.pat.mockResolvedValue(credential("account-c"));
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor");
    app.overlay.answerKeys({ action: "pick", rows: [{ slotId: "account-b", value: "", disabled: true }], activeIndex: 0 });
    await choosePat(app); await waitOverlay(app, "keys-editor");
    expect(h.keys).toHaveLength(2); expect(h.keys[0]).toEqual(sibling);
    expect(parseQoderCredential(h.keys[1]!.value).uid).toBe("account-c");
    cancelOverlay(app); await result;
  });

  it("deduplicates reauthentication without enabling or replacing sibling accounts", async () => {
    const selected = addSlot("account-a", true); const sibling = addSlot("account-b");
    h.activeIndex = 1;
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor");
    app.overlay.answerKeys({ action: "pick", rows: h.keys.map((key) => ({ slotId: key.id, value: "", disabled: key.disabled })), activeIndex: 1 });
    await choosePat(app); await waitOverlay(app, "keys-editor");
    expect(h.keys).toHaveLength(2); expect(h.keys[0]).toMatchObject({ id: selected.id, createdAt: 1, disabled: true });
    expect(h.keys[1]).toEqual(sibling); expect(h.activeIndex).toBe(1);
    expect(h.append).not.toHaveBeenCalled(); expect(h.enable).not.toHaveBeenCalled();
    cancelOverlay(app); await result;
  });

  it("commits pending account edits before refreshing the selected slot", async () => {
    addSlot("account-a"); const sibling = addSlot("account-b");
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor");
    app.overlay.answerKeys({ action: "refresh", slotId: "account-a", rows: [
      { slotId: "account-a", value: "account-a@test.invalid", disabled: true },
      { slotId: "account-b", value: "", disabled: false },
    ], activeIndex: 1 });
    await waitOverlay(app, "keys-editor");
    expect(h.refresh).toHaveBeenCalledWith("account-a");
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.refresh.mock.invocationCallOrder[0]!);
    expect(h.keys[0]?.disabled).toBe(true); expect(h.keys[1]).toEqual(sibling);
    expect(h.activeIndex).toBe(1);
    cancelOverlay(app); await result;
  });

  it("reauthenticates a rejected refresh only as the same account", async () => {
    const original = addSlot("account-a", true); const sibling = addSlot("account-b");
    h.activeIndex = 1; h.refresh.mockRejectedValue(new QoderAuthError("expired", 401));
    h.pat.mockResolvedValue({ ...credential(), accessToken: "reauthenticated-access" });
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor"); app.overlay.answerKeys({ action: "refresh", slotId: original.id });
    await choosePat(app); await waitOverlay(app, "keys-editor");
    expect(h.keys[0]).toMatchObject({ id: original.id, createdAt: 1, disabled: true });
    expect(parseQoderCredential(h.keys[0]!.value).accessToken).toBe("reauthenticated-access");
    expect(h.keys[1]).toEqual(sibling); expect(h.activeIndex).toBe(1);
    cancelOverlay(app); await result;
  });

  it("rejects different-account reauthentication without changing stored accounts", async () => {
    addSlot("account-a"); addSlot("account-b");
    const original = h.keys.map((key) => ({ ...key }));
    h.refresh.mockRejectedValue(new QoderAuthError("expired", 401)); h.pat.mockResolvedValue(credential("account-c"));
    const app = services(); const notice = vi.spyOn(app.session, "notice"); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor"); app.overlay.answerKeys({ action: "refresh", slotId: "account-a" });
    await choosePat(app); await waitOverlay(app, "keys-editor");
    expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("different Qoder account"));
    expect(h.keys).toEqual(original); expect(h.replace).not.toHaveBeenCalled(); expect(h.append).not.toHaveBeenCalled();
    cancelOverlay(app); await result;
  });

  it("keeps the editor responsive and accounts intact after a refresh failure", async () => {
    addSlot("account-a"); const original = h.keys[0];
    h.refresh.mockRejectedValue(new QoderAuthError("network unavailable", 503));
    const app = services(); const result = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor"); app.overlay.answerKeys({ action: "refresh", slotId: "account-a" });
    await waitOverlay(app, "keys-editor"); expect(h.keys[0]).toEqual(original);
    cancelOverlay(app); await result; expect(app.focus.activeContext()).toBe("composer");
  });

  it("removes all accounts on reset and leaves cancellation non-mutating", async () => {
    addSlot("account-a");
    const app = services(); const cancelled = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor"); cancelOverlay(app); await cancelled;
    expect(h.keys).toHaveLength(1); expect(h.save).not.toHaveBeenCalled();
    const reset = openQoderKeysFlow(app);
    await waitOverlay(app, "keys-editor"); app.overlay.answerKeys({ action: "reset" }); await reset;
    expect(h.reset).toHaveBeenCalledWith("qoder"); expect(h.keys).toEqual([]);
  });
});
