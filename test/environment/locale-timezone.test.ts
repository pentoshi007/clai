import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTestEnv, CANONICAL_TEST_ENV } from "../../scripts/run-tests.mjs";

/**
 * Locale/timezone characterization (Phase 0, P0-02).
 *
 * Node fixes ICU collation, number formatting and the default timezone when the
 * process starts, so every case here runs `locale-probe.ts` in a child process
 * with an explicit environment. The probe drives real production surfaces
 * (`StreamRenderer`, `fsList`, `formatTokenCount`).
 *
 * These tests record the behavior that exists at the refactor anchor. They do
 * **not** endorse it: the host-sensitive `toLocaleString()` calls in
 * `src/noninteractive/stream-blocks.ts` are documented as actionable debt in
 * `refactor/evidence/phase-0/warning-ledger.md`. Changing that formatting is a
 * separately approved behavior change, not part of Phase 0.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = join(REPO_ROOT, "test", "environment", "locale-probe.ts");

interface ProbeReport {
  env: { LANG: string | null; LC_ALL: string | null; TZ: string | null };
  intl: { resolvedNumberLocale: string; resolvedDateTimeZone: string };
  numbers: {
    hostFormatted: string;
    pinnedEnUs: string;
    productionTokenCount: string;
    productionTokenCountCompact: string;
  };
  noninteractive: { compactionLines: string[] };
  fsList: { order: string[]; header: string };
  collation: {
    isoTimestampOrder: string[];
    numericAwareOrder: string[];
    codeUnitOrder: string[];
  };
  dates: {
    iso: string;
    epochMs: number;
    localDate: number;
    localHours: number;
    timezoneOffsetMinutes: number;
    localeDateString: string;
  };
}

function runProbe(overrides: Record<string, string>): ProbeReport {
  // Start from the canonical environment so a stray host LANGUAGE/LC_CTYPE
  // cannot influence a case that only means to override LANG/LC_ALL/TZ.
  const env = { ...buildTestEnv(process.env), ...overrides };
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", PROBE],
    { cwd: REPO_ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as ProbeReport;
}

const canonical = runProbe({});

const indian = runProbe({
  LANG: "en_IN.utf8",
  LC_ALL: "en_IN.utf8",
  TZ: "Asia/Kolkata",
});

/**
 * Some hosts and CI images ship without the `en_IN` locale data. Detect that
 * honestly instead of asserting a contract the environment cannot produce.
 */
const hasIndianLocale = indian.intl.resolvedNumberLocale === "en-IN";

describe("canonical test environment", () => {
  it("applies the documented locale and timezone before Node starts", () => {
    expect(canonical.env).toEqual({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
    expect(CANONICAL_TEST_ENV.TZ).toBe("UTC");
    expect(canonical.intl.resolvedDateTimeZone).toBe("UTC");
    expect(canonical.dates.timezoneOffsetMinutes).toBe(0);
  });

  it("resolves ICU number formatting to en-US under LC_ALL=C", () => {
    // Documented contract: `LC_ALL=C` does not select byte semantics inside
    // Node's ICU; it falls back to the en-US default. Group separators are
    // therefore present, and `<500`-style grouping expectations in the suite
    // depend on this exact behavior.
    expect(canonical.intl.resolvedNumberLocale).toBe("en-US");
    expect(canonical.numbers.hostFormatted).toBe("120,000");
  });

  it("renders the noninteractive compaction transcript exactly", () => {
    expect(canonical.noninteractive.compactionLines).toEqual([
      "✦ compacting context · ~120,000 tokens before",
      "✦ compacted context · ~120,000 → ~30,000 tokens",
    ]);
  });

  it("orders fs.list numerically with hidden and directory entries included", () => {
    expect(canonical.fsList.order).toEqual([
      ".hidden",
      "dirA",
      "item1.txt",
      "item2.txt",
      "Item3.txt",
      "item10.txt",
    ]);
    expect(canonical.fsList.header).toMatch(/: 6 entries \(1 hidden included\)$/);
  });

  it("keeps ISO timestamp ordering stable for job listings", () => {
    expect(canonical.collation.isoTimestampOrder).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-10T00:00:00.000Z",
    ]);
  });

  it("keeps a UTC instant on its UTC calendar day", () => {
    expect(canonical.dates.iso).toBe("2026-02-28T23:30:00.000Z");
    expect(canonical.dates.localDate).toBe(28);
    expect(canonical.dates.localHours).toBe(23);
  });
});

describe("host-sensitive behavior under en_IN and Asia/Kolkata", () => {
  it.skipIf(!hasIndianLocale)("groups numbers in the Indian system", () => {
    expect(indian.intl.resolvedNumberLocale).toBe("en-IN");
    expect(indian.numbers.hostFormatted).toBe("1,20,000");
  });

  it.skipIf(!hasIndianLocale)(
    "changes noninteractive compaction output — the recorded baseline discrepancy",
    () => {
      // This is exactly why the canonical wrapper exists: the unqualified suite
      // fails two expectations on an en_IN host. Recorded, not fixed, in Phase 0.
      expect(indian.noninteractive.compactionLines).toEqual([
        "✦ compacting context · ~1,20,000 tokens before",
        "✦ compacted context · ~1,20,000 → ~30,000 tokens",
      ]);
      expect(indian.noninteractive.compactionLines).not.toEqual(
        canonical.noninteractive.compactionLines,
      );
    },
  );

  it.skipIf(!hasIndianLocale)("leaves locale-pinned formatters unaffected", () => {
    // `formatTokenCount` pins "en-US", so token accounting output is stable
    // across hosts. Any future move of display formatting onto this helper is a
    // behavior change requiring separate approval.
    expect(indian.numbers.pinnedEnUs).toBe("120,000");
    expect(indian.numbers.productionTokenCount).toBe("120,000");
    expect(indian.numbers.productionTokenCountCompact).toBe("120k");
    expect(indian.numbers.productionTokenCount).toBe(
      canonical.numbers.productionTokenCount,
    );
  });

  it.skipIf(!hasIndianLocale)("keeps fs.list and job ordering identical", () => {
    // Numeric-aware ICU collation and ISO-8601 comparison agree between the two
    // locales, so ordering is not a locale risk at this anchor.
    expect(indian.fsList.order).toEqual(canonical.fsList.order);
    expect(indian.collation.numericAwareOrder).toEqual(
      canonical.collation.numericAwareOrder,
    );
    expect(indian.collation.isoTimestampOrder).toEqual(
      canonical.collation.isoTimestampOrder,
    );
  });

  it.skipIf(!hasIndianLocale)("moves a late-UTC instant onto the next local day", () => {
    expect(indian.dates.iso).toBe(canonical.dates.iso);
    expect(indian.dates.epochMs).toBe(canonical.dates.epochMs);
    expect(indian.dates.timezoneOffsetMinutes).toBe(-330);
    expect(indian.dates.localDate).toBe(1);
    expect(indian.dates.localHours).toBe(5);
  });
});

describe("deterministic wrapper environment construction", () => {
  it("strips inherited locale variables that ICU still honors", () => {
    const env = buildTestEnv({
      LANGUAGE: "hi_IN",
      LC_CTYPE: "en_IN.utf8",
      LC_MESSAGES: "en_IN.utf8",
      PATH: "/usr/bin",
    });
    expect(env.LANGUAGE).toBeUndefined();
    expect(env.LC_CTYPE).toBeUndefined();
    expect(env.LC_MESSAGES).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LC_ALL).toBe("C");
    expect(env.TZ).toBe("UTC");
  });

  it("preserves the host environment on the direct path", () => {
    const env = buildTestEnv({ LANG: "en_IN.utf8", TZ: "Asia/Kolkata" }, { host: true });
    expect(env.LANG).toBe("en_IN.utf8");
    expect(env.TZ).toBe("Asia/Kolkata");
  });
});
