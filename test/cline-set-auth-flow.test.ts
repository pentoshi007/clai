import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  token: "workos:fake-token-aaaaaaaaaaaaaaaa",
  startClineDeviceAuth: vi.fn(),
  pollClineDeviceAuth: vi.fn(),
  appendProviderKey: vi.fn(),
  replaceProviderKey: vi.fn(),
  setProviderKeys: vi.fn(),
  stored: [] as Array<{
    id: string;
    value: string;
    createdAt: number;
    disabled?: boolean;
    refreshToken?: string;
    expiresAt?: number;
  }>,
}));

vi.mock("../src/llm/cline-auth.js", () => ({
  CLINE_API_BASE_URL: "https://api.cline.bot/api/v1",
  CLINE_REQUEST_HEADERS: { "X-CLIENT-TYPE": "cline-desktop" },
  isClineOAuthToken: (value: string) => value.startsWith("workos:"),
  maybeRefreshClineToken: async () => undefined,
  startClineDeviceAuth: h.startClineDeviceAuth,
  pollClineDeviceAuth: h.pollClineDeviceAuth,
}));

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) =>
      provider === "cline"
        ? { keys: h.stored, activeIndex: 0, source: "fallback" as const }
        : { keys: [], activeIndex: 0, source: "missing" as const },
    appendProviderKey: h.appendProviderKey,
    replaceProviderKey: h.replaceProviderKey,
    setProviderKeys: h.setProviderKeys,
    unsetProviderSecret: async () => undefined,
  };
});

const FAKE_TOKEN = h.token;

function makeServices(answers: Array<unknown>) {
  let busy: string | null = null;
  const notices: string[] = [];
  const events: string[] = [];
  const overlay = {
    close: () => {
      if (busy === "pager") events.push("close:pager");
      else if (busy === "editor") events.push("close:editor");
      else events.push("close:idle");
      busy = null;
    },
    openPager: () => {
      if (busy !== null) return false;
      busy = "pager";
      events.push("open:pager");
      return true;
    },
    openPicker: () => true,
    openSecret: async () => undefined,
    openKeysEditor: async () => {
      if (busy !== null) return undefined;
      busy = "editor";
      events.push("open:editor");
      const answer = answers.length > 0 ? answers.shift() : undefined;
      busy = null;
      return answer;
    },
  };
  const services = {
    overlay,
    toast: { info: () => "t", dismiss: () => undefined },
    session: {
      notice: (_level: string, text: string) => {
        notices.push(text);
      },
      getState: () => ({ provider: "cline" }),
      setProvider: () => undefined,
      setModel: () => undefined,
    },
  };
  return { services, notices, events };
}

describe("cline /set auth flow", () => {
  beforeEach(() => {
    h.stored.length = 0;
    h.startClineDeviceAuth.mockReset().mockResolvedValue({
      deviceCode: "dev",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://authkit.cline.bot/device?user_code=ABCD-EFGH",
      expiresInSeconds: 300,
      pollIntervalSeconds: 5,
    });
    h.pollClineDeviceAuth.mockReset().mockResolvedValue({ accessToken: FAKE_TOKEN });
    h.appendProviderKey.mockReset().mockImplementation(async (_p: string, value: string) => {
      h.stored.push({ id: `k${h.stored.length}`, value, createdAt: 0 });
      return "fallback" as const;
    });
    h.replaceProviderKey.mockReset().mockImplementation(
      async (
        _p: string,
        oldValue: string,
        newValue: string,
        metadata?: { refreshToken?: string; expiresAt?: number },
      ) => {
        const stored = h.stored.find((key) => key.value === oldValue);
        if (!stored) return false;
        stored.value = newValue;
        Object.assign(stored, metadata);
        return true;
      },
    );
    h.setProviderKeys.mockReset().mockImplementation(
      async (_p: string, values: readonly string[]) => {
        h.stored.length = 0;
        values.forEach((value, i) =>
          h.stored.push({ id: `k${i}`, value, createdAt: 0 }),
        );
        return "fallback" as const;
      },
    );
  });

  it("returns to the editor after auth instead of reporting cancelled", async () => {
    const { services, notices } = makeServices([
      { action: "pick", rows: [], activeIndex: 0 },
      { action: "save", rows: [{ value: FAKE_TOKEN }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(h.pollClineDeviceAuth).toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith("cline", FAKE_TOKEN);
    expect(notices.some((text) => /^cancelled$/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalled();
  });

  it("commits removed accounts before adding a new authenticated account", async () => {
    const oldToken = "workos:expired-token-aaaaaaaaaaaaaaaa";
    h.stored.push({ id: "k0", value: oldToken, createdAt: 0 });
    const { services } = makeServices([
      { action: "pick", rows: [], activeIndex: 0 },
      { action: "save", rows: [{ value: FAKE_TOKEN }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(h.stored.map((key) => key.value)).toEqual([FAKE_TOKEN]);
    expect(h.setProviderKeys.mock.calls[0]?.[1]).toEqual([]);
  });

  it("keeps remaining disabled accounts when adding from a changed draft", async () => {
    const removed = "workos:removed-token-aaaaaaaaaaaaaaaa";
    const remaining = "workos:remaining-token-bbbbbbbbbbbbbbbb";
    h.stored.push(
      { id: "k0", value: removed, createdAt: 0 },
      { id: "k1", value: remaining, createdAt: 0 },
    );
    const { services } = makeServices([
      {
        action: "pick",
        rows: [{ slotId: "k1", value: "masked", disabled: true }],
        activeIndex: 0,
      },
      undefined,
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(h.stored.map((key) => key.value)).toEqual([remaining, FAKE_TOKEN]);
    expect(h.setProviderKeys.mock.calls[0]?.[1]).toEqual([remaining]);
    expect(h.setProviderKeys.mock.calls[0]?.[3]).toEqual([remaining]);
  });

  it("does not leave the sign-in pager blocking the editor", async () => {
    const { services, events } = makeServices([
      { action: "pick", rows: [], activeIndex: 0 },
      { action: "save", rows: [{ value: FAKE_TOKEN }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    const pagerOpen = events.indexOf("open:pager");
    const editorReopen = events.indexOf("open:editor", pagerOpen);
    expect(pagerOpen).toBeGreaterThanOrEqual(0);
    expect(editorReopen).toBeGreaterThan(pagerOpen);
    expect(h.setProviderKeys.mock.calls.at(-1)?.[1]).toEqual([FAKE_TOKEN]);
  });

  it("reauthenticates the selected account and preserves its slot state", async () => {
    const oldToken = "workos:old-token-aaaaaaaaaaaaaaaa";
    const newToken = "workos:new-token-bbbbbbbbbbbbbbbb";
    h.stored.push({
      id: "k0",
      value: oldToken,
      createdAt: 0,
      disabled: true,
      refreshToken: "old-refresh",
    });
    h.pollClineDeviceAuth.mockResolvedValue({
      accessToken: newToken,
      refreshToken: "new-refresh",
      expiresAt: 123,
    });
    const { services, notices } = makeServices([
      { action: "refresh", slotId: "k0" },
      undefined,
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(h.replaceProviderKey).toHaveBeenCalledWith(
      "cline",
      oldToken,
      newToken,
      { refreshToken: "new-refresh", expiresAt: 123 },
    );
    expect(h.stored[0]).toMatchObject({
      id: "k0",
      value: newToken,
      disabled: true,
      refreshToken: "new-refresh",
      expiresAt: 123,
    });
    expect(notices.some((text) => text.startsWith("refreshed Cline account "))).toBe(true);
  });

  it("saves star/disable/remove edits on untouched rows without invalid-token errors", async () => {
    const first = "workos:first-token-aaaaaaaaaaaaaaaa";
    const second = "workos:second-token-bbbbbbbbbbbbbbbb";
    h.stored.push(
      { id: "k0", value: first, createdAt: 0 },
      { id: "k1", value: second, createdAt: 0 },
    );
    const { services, notices } = makeServices([
      {
        action: "save",
        rows: [
          { slotId: "k0", value: "", disabled: true },
          { slotId: "k1", value: "", disabled: false },
        ],
        activeIndex: 1,
      },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(notices.some((text) => /invalid cline token/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalledWith(
      "cline",
      [first, second],
      1,
      [first],
    );
  });

  it("removes a stored account when its row is dropped on save", async () => {
    const first = "workos:first-token-aaaaaaaaaaaaaaaa";
    const second = "workos:second-token-bbbbbbbbbbbbbbbb";
    h.stored.push(
      { id: "k0", value: first, createdAt: 0 },
      { id: "k1", value: second, createdAt: 0 },
    );
    const { services, notices } = makeServices([
      {
        action: "save",
        rows: [{ slotId: "k1", value: "", disabled: false }],
        activeIndex: 0,
      },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "cline");

    expect(notices.some((text) => /invalid cline token/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalledWith("cline", [second], 0, []);
  });
});
