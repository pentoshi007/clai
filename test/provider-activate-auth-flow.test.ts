import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCodexKey } from "../src/llm/codex-auth.js";
import { resetSessionModelCache } from "../src/store/session-model.js";

const h = vi.hoisted(() => ({
  startCline: vi.fn(),
  pollCline: vi.fn(),
  startCodex: vi.fn(),
  pollCodex: vi.fn(),
  startCopilot: vi.fn(),
  pollCopilot: vi.fn(),
  appendProviderKey: vi.fn(),
  cliCline: vi.fn(),
  cliCodex: vi.fn(),
  cliCopilot: vi.fn(),
}));

vi.mock("../src/llm/cline-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/cline-auth.js")>();
  return {
    ...actual,
    startClineDeviceAuth: h.startCline,
    pollClineDeviceAuth: h.pollCline,
  };
});

vi.mock("../src/llm/codex-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/codex-auth.js")>();
  return {
    ...actual,
    startCodexDeviceAuth: h.startCodex,
    pollCodexDeviceAuth: h.pollCodex,
  };
});

vi.mock("../src/llm/copilot-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/copilot-auth.js")>();
  return {
    ...actual,
    startCopilotDeviceAuth: h.startCopilot,
    pollCopilotDeviceAuth: h.pollCopilot,
  };
});

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    envValue: () => undefined,
    getProviderSecret: async () => ({ value: undefined }),
    getProviderKeys: async () => ({
      keys: [],
      activeIndex: 0,
      source: "missing" as const,
    }),
    appendProviderKey: h.appendProviderKey,
  };
});

vi.mock("../src/llm/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    providerAuth: async () => ({}),
    getProvider: () => ({
      validateKey: () => true,
      listModels: async () => ["live-model"],
    }),
  };
});

vi.mock("../src/commands/providers.js", () => ({
  resolveClineTokensInteractive: h.cliCline,
  resolveCodexCredentialInteractive: h.cliCodex,
  resolveCopilotCredentialInteractive: h.cliCopilot,
}));

function makeServices() {
  const pagers: Array<{ title: string; body: string }> = [];
  const notices: string[] = [];
  const overlay = {
    close: () => undefined,
    openPager: (title: string, body: string) => {
      pagers.push({ title, body });
      return true;
    },
    openPicker: () => true,
    openSecret: async () => undefined,
  };
  const services = {
    overlay,
    toast: { info: () => "t", dismiss: () => undefined },
    session: {
      notice: (_level: string, text: string) => {
        notices.push(text);
      },
      setProvider: () => undefined,
      setModel: () => undefined,
      sessionId: "test-session",
    },
  };
  return { services, pagers, notices };
}

let modelDir: string;

beforeEach(() => {
  modelDir = mkdtempSync(join(tmpdir(), "clai-provider-activate-"));
  process.env.CLAI_SESSION_MODEL_DIR = modelDir;
  resetSessionModelCache();
  for (const fn of [
    h.startCline,
    h.pollCline,
    h.startCodex,
    h.pollCodex,
    h.startCopilot,
    h.pollCopilot,
    h.appendProviderKey,
    h.cliCline,
    h.cliCodex,
    h.cliCopilot,
  ]) {
    fn.mockReset();
  }
  h.appendProviderKey.mockResolvedValue("fallback" as const);
  h.cliCline.mockRejectedValue(new Error("CLI resolver must not run in TUI"));
  h.cliCodex.mockRejectedValue(new Error("CLI resolver must not run in TUI"));
  h.cliCopilot.mockRejectedValue(new Error("CLI resolver must not run in TUI"));
});

afterEach(async () => {
  resetSessionModelCache();
  delete process.env.CLAI_SESSION_MODEL_DIR;
  await rm(modelDir, { recursive: true, force: true });
});

describe("/provider keyless OAuth shows the sign-in pager", () => {
  it("cline opens the Cline sign-in pager with URL and code", async () => {
    const { services, pagers, notices } = makeServices();
    h.startCline.mockResolvedValue({
      deviceCode: "dev",
      userCode: "FFDM-HWPH",
      verificationUrl: "https://authkit.cline.bot/device?user_code=FFDM-HWPH",
      expiresInSeconds: 300,
      pollIntervalSeconds: 5,
    });
    h.pollCline.mockResolvedValue({
      accessToken: "workos:abc",
      refreshToken: "refresh-abc",
      expiresAt: 123,
    });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "cline" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Cline sign-in");
    expect(pagers[0]?.body).toContain(
      "https://authkit.cline.bot/device?user_code=FFDM-HWPH",
    );
    expect(pagers[0]?.body).toContain("FFDM-HWPH");
    expect(h.cliCline).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith("cline", "workos:abc", {
      refreshToken: "refresh-abc",
      expiresAt: 123,
    });
    expect(notices.some((text) => text.includes("provider → cline"))).toBe(true);
  });

  it("codex opens the Codex sign-in pager with URL and code", async () => {
    const { services, pagers, notices } = makeServices();
    h.startCodex.mockResolvedValue({
      deviceAuthId: "dev",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    h.pollCodex.mockResolvedValue({
      accessToken: "acc-new",
      accountId: "acct-new",
    });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "codex" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Codex sign-in");
    expect(pagers[0]?.body).toContain("https://auth.openai.com/codex/device");
    expect(pagers[0]?.body).toContain("ABCD-EFGH");
    expect(h.cliCodex).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith(
      "codex",
      encodeCodexKey({ accessToken: "acc-new", accountId: "acct-new" }),
    );
    expect(notices.some((text) => text.includes("provider → codex"))).toBe(true);
  });

  it("copilot opens the Copilot sign-in pager with URL and code", async () => {
    const { services, pagers, notices } = makeServices();
    h.startCopilot.mockResolvedValue({
      deviceCode: "dev",
      userCode: "7BB3-F9E7",
      verificationUrl: "https://github.com/login/device",
      expiresInSeconds: 899,
      pollIntervalSeconds: 5,
    });
    h.pollCopilot.mockResolvedValue("ghu_testtoken");

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "copilot" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Copilot sign-in");
    expect(pagers[0]?.body).toContain("https://github.com/login/device");
    expect(pagers[0]?.body).toContain("7BB3-F9E7");
    expect(h.cliCopilot).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith("copilot", "ghu_testtoken");
    expect(notices.some((text) => text.includes("provider → copilot"))).toBe(
      true,
    );
  });
});
