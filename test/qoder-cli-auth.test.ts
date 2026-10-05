import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authQoder } from "../src/commands/qoder.js";
import type { QoderCredential } from "../src/llm/qoder/qoder-credential.js";

const h = vi.hoisted(() => ({
  choice: vi.fn(), secret: vi.fn(), start: vi.fn(), poll: vi.fn(), pat: vi.fn(), import: vi.fn(),
  store: vi.fn(), browser: vi.fn(), source: "keychain",
}));
vi.mock("../src/noninteractive/readline-prompts.js", () => ({ askChoice: h.choice, askSecret: h.secret }));
vi.mock("../src/llm/qoder/qoder-login.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/llm/qoder/qoder-login.js")>(),
  startQoderDeviceAuth: h.start, pollQoderDeviceAuth: h.poll, loginQoderWithPat: h.pat, importQoderAccount: h.import,
}));
vi.mock("../src/llm/qoder/qoder-accounts.js", () => ({ storeQoderAccount: h.store }));
vi.mock("../src/store/keys.js", () => ({
  getFallbackKeysPath: () => "/fixture-home/.clai/keys.json",
  getProviderKeys: async () => ({ source: h.source, keys: [{ id: "fixture-slot" }], activeIndex: 0 }),
}));
vi.mock("../src/mcp/auth/loopback.js", () => ({ openSystemBrowser: h.browser }));
const data: QoderCredential = {
  uid: "fixture-user", email: "fixture@test.invalid", accessToken: "fixture-access",
  machineId: "fixture-machine", machineToken: "fixture-token",
};
let stdinDescriptor: PropertyDescriptor | undefined;
let previousExitCode: typeof process.exitCode;
function tty(value: boolean): void { Object.defineProperty(process.stdin, "isTTY", { configurable: true, value }); }

beforeEach(() => {
  stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  previousExitCode = process.exitCode;
  tty(true); h.source = "keychain";
  for (const value of Object.values(h)) if (typeof value === "function") value.mockReset();
  h.choice.mockResolvedValue("headless"); h.secret.mockResolvedValue("fixture-pat");
  h.start.mockResolvedValue({ authUrl: "https://qoder.com/device/selectAccounts?fixture=true" });
  for (const fn of [h.poll, h.pat, h.import]) fn.mockResolvedValue(data);
  h.browser.mockResolvedValue(undefined); h.store.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("CLAI_NO_BROWSER", "1");
});
afterEach(() => {
  if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  process.exitCode = previousExitCode;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe("native Qoder CLI sign-in", () => {
  it("offers headless first with PAT and explicit import alternatives", async () => {
    await authQoder("qoder");
    expect(h.choice).toHaveBeenCalledWith("Qoder sign-in method:", [
      expect.objectContaining({ value: "headless" }), expect.objectContaining({ value: "browser" }),
      expect.objectContaining({ value: "pat" }), expect.objectContaining({ value: "import" }),
    ]);
    expect(h.poll).toHaveBeenCalledOnce(); expect(h.import).not.toHaveBeenCalled();
    expect(h.browser).not.toHaveBeenCalled(); expect(h.store).toHaveBeenCalledWith(data);
  });

  it("selects headless without a prompt on non-interactive input", async () => {
    tty(false); await authQoder("qoder");
    expect(h.choice).not.toHaveBeenCalled(); expect(h.poll).toHaveBeenCalledOnce();
    expect(h.browser).not.toHaveBeenCalled();
  });

  it("honors --pat with a cancellable secure prompt", async () => {
    await authQoder("qoder", { pat: true });
    expect(h.secret).toHaveBeenCalledWith(expect.stringContaining("https://qoder.com/account/integrations"), { signal: expect.any(AbortSignal) });
    expect(h.pat).toHaveBeenCalledWith("fixture-pat", { signal: expect.any(AbortSignal) });
    expect(h.choice).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("fixture-pat");
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain("fixture-pat");
  });

  it("does not store an account when secure entry is cancelled", async () => {
    h.secret.mockResolvedValue(undefined); await authQoder("qoder", { pat: true });
    expect(h.pat).not.toHaveBeenCalled(); expect(h.store).not.toHaveBeenCalled();
  });

  it("imports credentials only when explicitly requested", async () => {
    await authQoder("qoder", { import: true });
    expect(h.import).toHaveBeenCalledOnce(); expect(h.start).not.toHaveBeenCalled();
    expect(h.choice).not.toHaveBeenCalled(); expect(h.store).toHaveBeenCalledWith(data);
  });

  it("returns to the method prompt after a failed device sign-in and permits PAT", async () => {
    h.choice.mockResolvedValueOnce("headless").mockResolvedValueOnce("pat");
    h.poll.mockRejectedValue(new Error("device sign-in rejected"));
    await authQoder("qoder");
    expect(h.choice).toHaveBeenCalledTimes(2); expect(h.pat).toHaveBeenCalledOnce();
    expect(h.store).toHaveBeenCalledOnce();
  });

  it("propagates authentication errors for non-interactive callers", async () => {
    tty(false); h.poll.mockRejectedValue(new Error("device sign-in rejected"));
    await expect(authQoder("qoder")).rejects.toThrow("device sign-in rejected");
    expect(h.store).not.toHaveBeenCalled();
  });

  it("aborts polling on SIGINT and removes its signal listener", async () => {
    const original = new Set(process.listeners("SIGINT"));
    h.poll.mockImplementation((_start, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const result = authQoder("qoder", { headless: true });
    await vi.waitFor(() => expect(h.poll).toHaveBeenCalledOnce());
    const cancel = process.listeners("SIGINT").find((listener) => !original.has(listener));
    expect(cancel).toBeDefined(); cancel?.(); await result;
    expect(h.store).not.toHaveBeenCalled();
    expect(new Set(process.listeners("SIGINT"))).toEqual(original);
  });

  it("warns when credentials require the restricted-permission fallback store", async () => {
    h.source = "fallback"; await authQoder("qoder", { pat: true });
    expect(process.exitCode).toBe(3);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("OS keychain unavailable"));
  });

  it("rejects other providers without starting authentication", async () => {
    await expect(authQoder("nvidia")).rejects.toThrow("requires the qoder provider");
    expect(h.start).not.toHaveBeenCalled(); expect(h.store).not.toHaveBeenCalled();
  });
});
