import { describe, expect, it } from "vitest";
import {
  parseProviderKeysPayload,
  serializeProviderKeysPayload,
} from "../../src/store/keys.js";
import { maskSecret, maskSecretTail } from "../../src/llm/provider.js";
import { formatKeyStatus } from "../../src/ui-core/rendering/format-keys.js";
import type { ProviderStatus } from "../../src/types.js";

describe("parseProviderKeysPayload", () => {
  it("treats legacy plain string as one key", () => {
    const p = parseProviderKeysPayload("gsk_legacykey12345678");
    expect(p.keys).toHaveLength(1);
    expect(p.keys[0]!.value).toBe("gsk_legacykey12345678");
    expect(p.activeIndex).toBe(0);
  });

  it("round-trips envelope", () => {
    const raw = serializeProviderKeysPayload(
      [
        { id: "a", value: "key-aaaa-1111", createdAt: 1 },
        { id: "b", value: "key-bbbb-2222", createdAt: 2 },
      ],
      1,
    );
    expect(raw.startsWith("{")).toBe(true);
    const p = parseProviderKeysPayload(raw);
    expect(p.keys.map((k) => k.value)).toEqual(["key-aaaa-1111", "key-bbbb-2222"]);
    expect(p.activeIndex).toBe(1);
  });

  it("clamps activeIndex", () => {
    const raw = serializeProviderKeysPayload(
      [{ id: "a", value: "only-one-key-xx", createdAt: 1 }],
      99,
    );
    expect(parseProviderKeysPayload(raw).activeIndex).toBe(0);
  });

  it("dedupes empty values on serialize", () => {
    const raw = serializeProviderKeysPayload(
      [
        { id: "a", value: "  ", createdAt: 1 },
        { id: "b", value: "keep-me-please", createdAt: 2 },
      ],
      0,
    );
    const p = parseProviderKeysPayload(raw);
    expect(p.keys).toHaveLength(1);
    expect(p.keys[0]!.value).toBe("keep-me-please");
  });
});

describe("mask helpers", () => {
  it("maskSecretTail shows last 4", () => {
    expect(maskSecretTail("gsk_abcdefghijklmnop")).toBe("…mnop");
    expect(maskSecretTail("ab")).toBe("••••");
  });
});

describe("formatKeyStatus multi-key", () => {
  it("lists each masked key with active star", () => {
    const llm: ProviderStatus[] = [
      {
        provider: "groq",
        label: "groq",
        active: true,
        configured: true,
        source: "fallback",
        maskedKey: maskSecret("gsk_aaaa1111bbbb2222"),
        keyCount: 2,
        maskedKeys: [
          maskSecret("gsk_aaaa1111bbbb2222"),
          maskSecret("gsk_cccc3333dddd4444"),
        ],
        activeMaskedKey: maskSecret("gsk_cccc3333dddd4444"),
        model: "llama",
      },
    ];
    const text = formatKeyStatus(llm, []);
    expect(text).toContain("2 keys");
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(text).toContain("★ active");
    expect(text).toMatch(/multi-keys|\/set/i);
  });
});
