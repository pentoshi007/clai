import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCodexKey } from "../src/llm/codex-auth.js";
import type { CodexCredential } from "../src/llm/codex-auth.js";

const h = vi.hoisted(() => ({
  startCodexBrowserAuth: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
  pollCodexDeviceAuth: vi.fn(),
  appendProviderKey: vi.fn(),
  replaceProviderKey: vi.fn(),
  setProviderKeys: vi.fn(),
  stored: [] as Array<{
    id: string;
    value: string;
    createdAt: number;
    disabled?: boolean;
  }>,
}));

vi.mock("../src/llm/codex-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/codex-auth.js")>();
  return {
    ...actual,
    startCodexBrowserAuth: h.startCodexBrowserAuth,
    startCodexDeviceAuth: h.startCodexDeviceAuth,
    pollCodexDeviceAuth: h.pollCodexDeviceAuth,
  };
});

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) =>
      provider === "codex"
        ? { keys: h.stored, activeIndex: 0, source: "fallback" as const }
        : { keys: [], activeIndex: 0, source: "missing" as const },
    appendProviderKey: h.appendProviderKey,
    replaceProviderKey: h.replaceProviderKey,
    setProviderKeys: h.setProviderKeys,
    unsetProviderSecret: async () => undefined,
  };
});

function credential(accessToken: string, accountId: string): CodexCredential {
  return { accessToken, accountId };
}

const NEW_CREDENTIAL = credential("acc-new-aaaaaaaaaaaaaaaa", "acct-new");
const NEW_KEY = encodeCodexKey(NEW_CREDENTIAL);

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
    openPicker: (
      _request: unknown,
      onSelect?: (value: string) => void,
    ) => {
      onSelect?.("headless");
      return true;
    },
    openSecret: async () => undefined,
    isOpen: () => true,
    subscribe: () => () => undefined,
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
      getState: () => ({ provider: "codex" }),
      setProvider: () => undefined,
      setModel: () => undefined,
    },
  };
  return { services, notices, events };
}

describe("codex /set auth flow", () => {
  beforeEach(() => {
    h.stored.length = 0;
    h.startCodexBrowserAuth.mockReset().mockRejectedValue(new Error("no browser"));
    h.startCodexDeviceAuth.mockReset().mockResolvedValue({
      deviceAuthId: "dev",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      expiresInSeconds: 900,
      pollIntervalSeconds: 5,
    });
    h.pollCodexDeviceAuth.mockReset().mockResolvedValue(NEW_CREDENTIAL);
    h.appendProviderKey.mockReset().mockImplementation(async (_p: string, value: string) => {
      h.stored.push({ id: `k${h.stored.length}`, value, createdAt: 0 });
      return "fallback" as const;
    });
    h.replaceProviderKey.mockReset().mockImplementation(
      async (_p: string, oldValue: string, newValue: string) => {
        const stored = h.stored.find((key) => key.value === oldValue);
        if (!stored) return false;
        stored.value = newValue;
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
      { action: "save", rows: [{ value: NEW_KEY }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "codex");

    expect(h.pollCodexDeviceAuth).toHaveBeenCalled();
    expect(h.appendProviderKey).toHaveBeenCalledWith("codex", NEW_KEY);
    expect(notices.some((text) => /^cancelled$/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalled();
  });

  it("commits removed accounts before adding a new authenticated account", async () => {
    const oldKey = encodeCodexKey(credential("acc-expired-aaaaaaaaaaaaaaaa", "acct-expired"));
    h.stored.push({ id: "k0", value: oldKey, createdAt: 0 });
    const { services } = makeServices([
      { action: "pick", rows: [], activeIndex: 0 },
      { action: "save", rows: [{ value: NEW_KEY }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "codex");

    expect(h.stored.map((key) => key.value)).toEqual([NEW_KEY]);
    expect(h.setProviderKeys.mock.calls[0]?.[1]).toEqual([]);
  });

  it("does not leave the sign-in pager blocking the editor", async () => {
    const { services, events } = makeServices([
      { action: "pick", rows: [], activeIndex: 0 },
      { action: "save", rows: [{ value: NEW_KEY }], activeIndex: 0 },
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "codex");

    const pagerOpen = events.indexOf("open:pager");
    const editorReopen = events.indexOf("open:editor", pagerOpen);
    expect(pagerOpen).toBeGreaterThanOrEqual(0);
    expect(editorReopen).toBeGreaterThan(pagerOpen);
    expect(h.setProviderKeys.mock.calls.at(-1)?.[1]).toEqual([NEW_KEY]);
  });

  it("reauthenticates the selected account and preserves its slot state", async () => {
    const oldKey = encodeCodexKey(credential("acc-old-aaaaaaaaaaaaaaaa", "acct-old"));
    h.stored.push({ id: "k0", value: oldKey, createdAt: 0, disabled: true });
    const { services, notices } = makeServices([
      { action: "refresh", slotId: "k0" },
      undefined,
    ]);

    const { openLlmKeysEditor } = await import(
      "../src/ui-core/commands/key-commands.js"
    );
    await openLlmKeysEditor(services as never, "codex");

    expect(h.replaceProviderKey).toHaveBeenCalledWith("codex", oldKey, NEW_KEY);
    expect(h.stored[0]).toMatchObject({ id: "k0", value: NEW_KEY, disabled: true });
    expect(notices.some((text) => text.startsWith("refreshed ChatGPT Subscription account "))).toBe(true);
  });

  it("saves star/disable/remove edits on untouched rows without invalid-token errors", async () => {
    const first = encodeCodexKey(credential("acc-first-aaaaaaaaaaaaaa", "acct-first"));
    const second = encodeCodexKey(credential("acc-second-bbbbbbbbbbbb", "acct-second"));
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
    await openLlmKeysEditor(services as never, "codex");

    expect(notices.some((text) => /invalid codex token/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalledWith(
      "codex",
      [first, second],
      1,
      [first],
    );
  });

  it("removes a stored account when its row is dropped on save", async () => {
    const first = encodeCodexKey(credential("acc-first-aaaaaaaaaaaaaa", "acct-first"));
    const second = encodeCodexKey(credential("acc-second-bbbbbbbbbbbb", "acct-second"));
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
    await openLlmKeysEditor(services as never, "codex");

    expect(notices.some((text) => /invalid codex token/i.test(text))).toBe(false);
    expect(h.setProviderKeys).toHaveBeenCalledWith("codex", [second], 0, []);
  });
});
