import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeyMetadata, ProviderKeySlot } from "../src/store/keys.js";
import type { QoderCredential } from "../src/llm/qoder/qoder-credential.js";

const h = vi.hoisted(() => ({
  keys: [] as ProviderKeySlot[],
  activeIndex: 0,
  append: vi.fn(),
  replace: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async () => ({ keys: h.keys.map((key) => ({ ...key })), activeIndex: h.activeIndex, source: "fallback" as const }),
    appendProviderKey: h.append,
    replaceProviderKey: h.replace,
    setProviderKeys: h.save,
  };
});

function credential(uid = "account-a", overrides: Partial<QoderCredential> = {}): QoderCredential {
  return {
    uid,
    email: `${uid}@test.invalid`,
    accessToken: `${uid}-old-access`,
    refreshToken: `${uid}-refresh`,
    expireTime: Math.floor((Date.now() + 60_000) / 1000),
    machineId: "fixture-machine",
    machineToken: "fixture-umid",
    encryptUserInfo: "old-signer-info",
    key: "old-signer-key",
    ...overrides,
  };
}

function slot(id: string, data: QoderCredential, disabled = false): ProviderKeySlot {
  return { id, value: JSON.stringify(data), createdAt: 1, refreshToken: data.refreshToken, disabled };
}

beforeEach(() => {
  vi.resetModules();
  h.keys = [];
  h.activeIndex = 0;
  h.append.mockReset().mockImplementation(async (_provider: string, value: string, metadata?: ProviderKeyMetadata) => {
    h.keys.push({ id: `slot-${h.keys.length}`, value, createdAt: 2, ...metadata });
    return "fallback";
  });
  h.replace.mockReset().mockImplementation(async (_provider: string, oldValue: string, value: string, metadata?: ProviderKeyMetadata) => {
    const snapshot = h.keys.map((key) => ({ ...key }));
    const index = snapshot.findIndex((key) => key.value === oldValue);
    if (index < 0) return false;
    await Promise.resolve();
    snapshot[index] = { ...snapshot[index]!, value, ...metadata };
    h.keys = snapshot;
    return true;
  });
  h.save.mockReset().mockImplementation(async (_provider: string, values: string[], activeIndex: number, disabled: string[] = []) => {
    h.keys = values.map((value, index) => ({
      ...(h.keys.find((key) => key.value === value) ?? { id: `slot-${index}`, createdAt: 2 }),
      value,
      disabled: disabled.includes(value),
    }));
    h.activeIndex = activeIndex;
    return "fallback";
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Qoder account lifecycle", () => {
  it("reuses a stable slot when the same account signs in again", async () => {
    const old = credential();
    h.keys.push(slot("original-slot", old, true));
    const { storeQoderAccount } = await import("../src/llm/qoder/qoder-accounts.js");
    await storeQoderAccount({ ...old, accessToken: "replacement-access" });
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]).toMatchObject({ id: "original-slot", createdAt: 1, disabled: true });
    expect(JSON.parse(h.keys[0]!.value).accessToken).toBe("replacement-access");
    expect(h.append).not.toHaveBeenCalled();
  });

  it("adds distinct account ids without replacing other accounts", async () => {
    h.keys.push(slot("original-slot", credential()));
    const { storeQoderAccount } = await import("../src/llm/qoder/qoder-accounts.js");
    await storeQoderAccount(credential("account-b"));
    expect(h.keys).toHaveLength(2);
    expect(h.keys[0]?.id).toBe("original-slot");
    expect(h.activeIndex).toBe(0);
  });

  it("refreshes only the selected account and regenerates signer authentication", async () => {
    h.keys.push(slot("slot-a", credential(), true), slot("slot-b", credential("account-b")));
    h.activeIndex = 1;
    const untouched = h.keys[1];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      device_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600,
    })));
    vi.stubGlobal("fetch", fetcher);
    const { refreshQoderAccount } = await import("../src/llm/qoder/qoder-refresh.js");
    const fresh = await refreshQoderAccount("slot-a");
    expect(fresh.accessToken).toBe("fresh-access");
    expect(fresh.encryptUserInfo).not.toBe("old-signer-info");
    expect(fresh.key).not.toBe("old-signer-key");
    expect(h.keys[0]).toMatchObject({ id: "slot-a", createdAt: 1, disabled: true, refreshToken: "rotated-refresh" });
    expect(h.keys[1]).toEqual(untouched);
    expect(h.activeIndex).toBe(1);
  });

  it("serializes persistence when two distinct accounts refresh together", async () => {
    h.keys.push(slot("slot-a", credential()), slot("slot-b", credential("account-b")));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      await Promise.resolve();
      return new Response(JSON.stringify({ token: `${body.refresh_token}-fresh`, expires_in: 3600 }));
    }));
    const { refreshQoderAccount } = await import("../src/llm/qoder/qoder-refresh.js");
    await Promise.all([refreshQoderAccount("slot-a"), refreshQoderAccount("slot-b")]);
    expect(h.keys.map((key) => JSON.parse(key.value).accessToken)).toEqual(["account-a-refresh-fresh", "account-b-refresh-fresh"]);
  });

  it("shares manual and automatic refresh instead of exchanging twice", async () => {
    const old = credential();
    h.keys.push(slot("slot-a", old));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ token: "fresh-access", expires_in: 3600 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { refreshQoderAccount, withQoderCredential } = await import("../src/llm/qoder/qoder-refresh.js");
    const auth = { apiKey: JSON.stringify(old) };
    const [manual, automatic] = await Promise.all([
      refreshQoderAccount("slot-a"),
      withQoderCredential(auth, async (data) => data.accessToken),
    ]);
    expect(automatic).toBe(manual.accessToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refreshes PAT accounts by re-exchanging the PAT like qodercli", async () => {
    h.keys.push(slot("slot-a", credential("account-a", { loginMethod: "token", personalAccessToken: "fixture-pat", refreshToken: undefined })));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ token: "pat-fresh", expires_in: 3600 })));
    vi.stubGlobal("fetch", fetcher);
    const { refreshQoderAccount } = await import("../src/llm/qoder/qoder-refresh.js");
    await refreshQoderAccount("slot-a");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).personal_token).toBe("fixture-pat");
  });

  it("keeps a newly rotated credential when an old editor draft is saved", async () => {
    const latest = credential("account-a", { accessToken: "already-rotated" });
    h.keys.push(slot("slot-a", latest), slot("slot-b", credential("account-b")));
    const { saveQoderAccounts } = await import("../src/llm/qoder/qoder-accounts.js");
    await saveQoderAccounts([{ slotId: "slot-a", value: "", disabled: true }], 0);
    expect(h.keys).toHaveLength(1);
    expect(JSON.parse(h.keys[0]!.value).accessToken).toBe("already-rotated");
    expect(h.keys[0]).toMatchObject({ id: "slot-a", disabled: true });
  });

  it("resolves displayed account labels by slot id instead of treating them as credentials", async () => {
    h.keys.push(slot("slot-a", credential()));
    const { saveQoderAccounts } = await import("../src/llm/qoder/qoder-accounts.js");
    await saveQoderAccounts([{ slotId: "slot-a", value: "account-a@test.invalid" }], 0);
    expect(JSON.parse(h.keys[0]!.value).uid).toBe("account-a");
  });

  it("keeps the selected account when a preceding stale draft row was already removed", async () => {
    h.keys.push(slot("slot-b", credential("account-b")), slot("slot-c", credential("account-c")));
    const { saveQoderAccounts } = await import("../src/llm/qoder/qoder-accounts.js");
    await saveQoderAccounts([
      { slotId: "removed-a", value: "" },
      { slotId: "slot-b", value: "" },
      { slotId: "slot-c", value: "" },
    ], 1);
    expect(h.keys[h.activeIndex]?.id).toBe("slot-b");
  });

  it("does not resurrect an account removed while an editor was open", async () => {
    const { saveQoderAccounts } = await import("../src/llm/qoder/qoder-accounts.js");
    await saveQoderAccounts([{ slotId: "removed-slot", value: "" }], 0);
    expect(h.save.mock.calls[0]?.[1]).toEqual([]);
  });

  it("reports a missing refresh target without network activity", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const { refreshQoderAccount } = await import("../src/llm/qoder/qoder-refresh.js");
    await expect(refreshQoderAccount("missing")).rejects.toThrow("not found");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
