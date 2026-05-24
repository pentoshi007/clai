import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("phase 11 — keys messaging is honest about plaintext fallback", () => {
  it("src/store/keys.ts no longer claims the fallback file is encrypted", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/store/keys.ts"),
      "utf8",
    );
    // The legacy "encrypted file" / "encrypted JSON" wording is gone.
    expect(src).not.toMatch(/encrypted (?:file|JSON|json)/i);
    // The new wording explicitly mentions "restricted-permission plaintext".
    expect(src).toMatch(/restricted-permission plaintext/i);
  });

  it("src/commands/doctor.ts surfaces the plaintext-fallback note", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/commands/doctor.ts"),
      "utf8",
    );
    expect(src).toMatch(/restricted-permission plaintext/i);
    expect(src).toMatch(/NOT encrypted/);
  });
});
