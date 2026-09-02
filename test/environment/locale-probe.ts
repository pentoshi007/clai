/**
 * Locale/timezone characterization probe (Phase 0, P0-02).
 *
 * This file is executed as a *child process* by
 * `test/environment/locale-timezone.test.ts`, because Node fixes ICU collation,
 * number formatting and the default timezone at startup. Importing production
 * modules inside an already-running Vitest worker therefore cannot observe a
 * different locale.
 *
 * It exercises real production surfaces (not re-implementations):
 *   - `StreamRenderer` (noninteractive) for compaction token rendering;
 *   - `fsList` for directory ordering and entry counts;
 *   - `formatTokenCount` for the locale-pinned `en-US` formatter;
 *   - the collation and date primitives used by job ordering.
 *
 * Output: a single JSON document on stdout. Nothing else may be written to
 * stdout so the parent can parse it strictly.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { fsList } from "../../src/tools/fs.js";
import { formatTokenCount } from "../../src/llm/token-usage.js";
import { fakeClock, fakeStream, FIXTURE_OUTCOME, scriptedEvents } from "../noninteractive/fixture.js";

/** Names chosen to expose numeric-aware collation differences. */
const LIST_FIXTURE_NAMES = ["item2.txt", "item10.txt", "Item3.txt", "item1.txt", ".hidden"];

/** Renders the scripted noninteractive turn and returns the stderr transcript. */
function renderNoninteractiveStderr(): string {
  const out = fakeStream(false);
  const err = fakeStream(false);
  const renderer = new StreamRenderer(
    {
      out,
      err,
      columns: 80,
      color: false,
      unicode: true,
      verbosity: "normal",
      showThinking: true,
    },
    fakeClock(),
  );
  for (const event of scriptedEvents()) renderer.handle(event);
  renderer.finish(FIXTURE_OUTCOME);
  return err.text();
}

/** Lists a deterministic fixture directory through the production tool. */
async function probeFsList(): Promise<{ order: string[]; header: string }> {
  const dir = mkdtempSync(join(tmpdir(), "clai-locale-probe-"));
  try {
    for (const name of LIST_FIXTURE_NAMES) writeFileSync(join(dir, name), "x");
    mkdirSync(join(dir, "dirA"));
    const result = await fsList(dir, { confirmed: true });
    const lines = result.output.split("\n");
    const header = lines[0] ?? "";
    const order = lines
      .slice(1)
      .map((line) => line.replace(/^(?:dir|file)\s+/, "").replace(/ \[hidden\]$/, ""));
    return { order, header };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const stderrTranscript = renderNoninteractiveStderr();
  const compactionLines = stderrTranscript
    .split("\n")
    .filter((line) => line.includes("compact"));

  // A fixed instant that lands on different calendar days depending on the
  // active timezone (23:30 UTC on 2026-02-28).
  const instant = new Date(Date.UTC(2026, 1, 28, 23, 30, 0));

  const report = {
    env: {
      LANG: process.env.LANG ?? null,
      LC_ALL: process.env.LC_ALL ?? null,
      TZ: process.env.TZ ?? null,
    },
    intl: {
      resolvedNumberLocale: new Intl.NumberFormat().resolvedOptions().locale,
      resolvedDateTimeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    numbers: {
      hostFormatted: (120000).toLocaleString(),
      pinnedEnUs: (120000).toLocaleString("en-US"),
      productionTokenCount: formatTokenCount(120000, false),
      productionTokenCountCompact: formatTokenCount(120000, true),
    },
    noninteractive: { compactionLines },
    fsList: await probeFsList(),
    collation: {
      // Production job ordering compares ISO-8601 timestamps with
      // `String.prototype.localeCompare`.
      isoTimestampOrder: ["2026-01-02T00:00:00.000Z", "2026-01-10T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]
        .slice()
        .sort((left, right) => left.localeCompare(right)),
      numericAwareOrder: ["item2", "item10", "Item3", "item1"]
        .slice()
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      codeUnitOrder: ["item2", "item10", "Item3", "item1"].slice().sort(),
    },
    dates: {
      iso: instant.toISOString(),
      epochMs: instant.getTime(),
      localDate: instant.getDate(),
      localHours: instant.getHours(),
      timezoneOffsetMinutes: instant.getTimezoneOffset(),
      localeDateString: instant.toLocaleDateString(),
    },
  };

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
