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
  browserCodex: vi.fn(),
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
    startCodexBrowserAuth: h.browserCodex,
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
  const names: Record<string, string> = {
    cline: "Cline",
    codex: "Chatgpt Subscription(free/go/plus/pro)",
    copilot: "Github Copilot",
  };
  return {
    ...actual,
    providerAuth: async () => ({}),
    getProvider: (id: string) => ({
      displayName: names[id] ?? id,
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

function makeServices(answers?: {
  pick?: string;
  secret?: string;
}) {
  const pagers: Array<{ title: string; body: string }> = [];
  const notices: string[] = [];
  const secrets: Array<{ title: string; prompt: string }> = [];
  const overlay = {
    close: () => undefined,
    openPager: (title: string, body: string) => {
      pagers.push({ title, body });
      return true;
    },
    openPicker: (
      _request: unknown,
      onSelect?: (value: string) => void,
    ) => {
      if (answers?.pick) onSelect?.(answers.pick);
      return true;
    },
    openSecret: async (request: { title: string; prompt: string }) => {
      secrets.push(request);
      return answers?.secret;
    },
    isOpen: () => true,
    subscribe: () => () => undefined,
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
  return { services, pagers, notices, secrets };
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
    h.browserCodex,
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
    await vi.waitFor(() =>
      expect(notices.some((text) => text.includes("provider → Cline"))).toBe(true),
    );
  });

  it("codex opens the ChatGPT browser sign-in pager like Zed", async () => {
    const { services, pagers, notices } = makeServices({ pick: "browser" });
    h.browserCodex.mockResolvedValue({
      url: "https://auth.openai.com/oauth/authorize?client_id=app_test&originator=codex_cli_rs",
      waitForCredential: async () => ({
        accessToken: "acc-new",
        accountId: "acct-new",
      }),
      close: () => undefined,
    });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "codex" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    expect(h.browserCodex).toHaveBeenCalled();
    expect(h.startCodex).not.toHaveBeenCalled();
    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("ChatGPT Subscription sign-in");
    expect(pagers[0]?.body).toContain("auth.openai.com/oauth/authorize");
    expect(h.cliCodex).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith(
      "codex",
      encodeCodexKey({ accessToken: "acc-new", accountId: "acct-new" }),
    );
    expect(notices.some((text) => text.includes("provider → Chatgpt Subscription"))).toBe(true);
  });

  it("codex falls back to the device-code pager when the browser flow cannot start", async () => {
    const { services, pagers, notices } = makeServices({ pick: "browser" });
    h.browserCodex.mockRejectedValue(new Error("no loopback ports"));
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
    expect(pagers[0]?.title).toBe("ChatGPT Subscription sign-in");
    expect(pagers[0]?.body).toContain("https://auth.openai.com/codex/device");
    expect(pagers[0]?.body).toContain("ABCD-EFGH");
    expect(h.cliCodex).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith(
      "codex",
      encodeCodexKey({ accessToken: "acc-new", accountId: "acct-new" }),
    );
    expect(notices.some((text) => text.includes("provider → Chatgpt Subscription"))).toBe(true);
  });

  it("codex headless choice goes straight to the device-code pager", async () => {
    const { services, pagers, notices } = makeServices({ pick: "headless" });
    h.startCodex.mockResolvedValue({
      deviceAuthId: "dev",
      userCode: "WXYZ-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    h.pollCodex.mockResolvedValue({
      accessToken: "acc-headless",
      accountId: "acct-headless",
    });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "codex" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    expect(h.browserCodex).not.toHaveBeenCalled();
    expect(h.startCodex).toHaveBeenCalled();
    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.body).toContain("WXYZ-1234");
    expect(h.appendProviderKey).toHaveBeenCalledWith(
      "codex",
      encodeCodexKey({ accessToken: "acc-headless", accountId: "acct-headless" }),
    );
    expect(notices.some((text) => text.includes("provider → Chatgpt Subscription"))).toBe(true);
  });

  it("codex apikey choice prompts for a token and stores it as a credential", async () => {
    const fakeJwt = [
      "eyJhbGciOiJFUzI1NiJ9",
      Buffer.from(JSON.stringify({ chatgpt_account_id: "acct-pasted" })).toString("base64url"),
      "sig",
    ].join(".");
    const { services, notices } = makeServices({ pick: "apikey", secret: fakeJwt });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "codex" });
    await vi.waitFor(() => expect(h.appendProviderKey).toHaveBeenCalled());

    const stored = h.appendProviderKey.mock.calls.at(-1)?.[1] as string;
    expect(stored.startsWith("codex:")).toBe(true);
    const { decodeCodexKey } = await import("../src/llm/codex-auth.js");
    expect(decodeCodexKey(stored)).toMatchObject({
      accessToken: fakeJwt,
      accountId: "acct-pasted",
    });
    expect(notices.some((text) => text.includes("provider → Chatgpt Subscription"))).toBe(true);
  });

  it("codex apikey choice rejects a token without a chatgpt account id", async () => {
    const badJwt = [
      "eyJhbGciOiJFUzI1NiJ9",
      Buffer.from(JSON.stringify({ sub: "nobody" })).toString("base64url"),
      "sig",
    ].join(".");
    const { services, notices } = makeServices({ pick: "apikey", secret: badJwt });

    const { handleProvider } = await import(
      "../src/ui-core/commands/picker-commands.js"
    );
    handleProvider(services as never, { name: "provider", args: "codex" });
    await vi.waitFor(() =>
      expect(notices.some((text) => /invalid ChatGPT token/.test(text))).toBe(true),
    );

    expect(h.appendProviderKey).not.toHaveBeenCalled();
  });

  it("copilot opens the Github Copilot sign-in pager with URL and code", async () => {
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
    expect(pagers[0]?.title).toBe("Github Copilot sign-in");
    expect(pagers[0]?.body).toContain("https://github.com/login/device");
    expect(pagers[0]?.body).toContain("7BB3-F9E7");
    expect(h.cliCopilot).not.toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith("copilot", "ghu_testtoken");
    expect(notices.some((text) => text.includes("provider → Github Copilot"))).toBe(
      true,
    );
  });
});
