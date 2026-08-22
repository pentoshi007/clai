import { describe, expect, it } from "vitest";
import { SessionUsageLedger } from "../../src/app/controllers/session-usage-ledger.js";
import {
  renderExitSummary,
  renderExitSummaryLines,
  resumeCommand,
  type ExitSummaryInput,
} from "../../src/ui-core/rendering/exit-summary.js";
import type { TokenUsage } from "../../src/llm/token-usage.js";

function usage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 1200,
    completionTokens: 340,
    totalTokens: 1540,
    exact: true,
    ...partial,
  };
}

function reportWith(
  entries: ReadonlyArray<{
    provider: "openai" | "nvidia";
    model: string;
    usage?: Partial<TokenUsage>;
  }>,
) {
  const ledger = new SessionUsageLedger();
  for (const entry of entries) {
    ledger.record(usage(entry.usage), entry.provider, entry.model);
  }
  return ledger.report();
}

function input(overrides: Partial<ExitSummaryInput> = {}): ExitSummaryInput {
  return {
    usage: reportWith([{ provider: "openai", model: "gpt-5.4-mini" }]),
    sessionId: "sess-abc123-def456",
    messages: 8,
    cwd: "/tmp/project",
    durationMs: 95_000,
    resumable: true,
    width: 100,
    color: false,
    unicode: true,
    ...overrides,
  };
}

const plain = (lines: readonly string[]): string => lines.join("\n");

describe("exit summary", () => {
  it("renders the wordmark, the usage table, and the resume command", () => {
    const lines = renderExitSummaryLines(input());
    const text = plain(lines);

    expect(text).toContain("█");
    expect(text).toContain("PROVIDER / MODEL");
    expect(text).toContain("openai / gpt-5.4-mini");
    expect(text).toContain("1,200");
    expect(text).toContain("340");
    expect(text).toContain("1,540");
    expect(text).toContain("TOTAL · 1 route");
    expect(text).toContain("Resume ");
    expect(text).toContain("clai --resume sess-abc123-def456");
  });

  it("labels the session lines in a dim label column", () => {
    const text = plain(
      renderExitSummaryLines(input({ title: "Add exit epilogue" })),
    );
    for (const label of ["Session", "Folder", "Worked", "Resume"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Session  Add exit epilogue");
    expect(text).toContain("Resume   clai --resume sess-abc123-def456");
  });

  it("puts the logo on the left and the session lines to its right", () => {
    const lines = renderExitSummaryLines(input({ title: "Add exit epilogue" }));
    const title = lines.find((line) => line.includes("Add exit epilogue"))!;
    const command = lines.find((line) => line.includes("clai --resume"))!;
    expect(title).toMatch(/^ {2}[▄█▀]/);
    expect(command).toMatch(/^ {2}[▄█▀]/);
    expect(lines.indexOf(title)).toBeLessThan(lines.indexOf(command));
  });

  it("draws no box around the summary", () => {
    const text = plain(renderExitSummaryLines(input()));
    for (const glyph of ["│", "╭", "╮", "╰", "╯", "├", "┤"]) {
      expect(text, `expected no ${glyph}`).not.toContain(glyph);
    }
  });

  it("aligns the table to its columns instead of the terminal width", () => {
    const lines = renderExitSummaryLines(input({ width: 120 }));
    const first = lines.findIndex((line) => line.includes("PROVIDER / MODEL"));
    const last = lines.findIndex((line) => line.includes("TOTAL · 1 route"));
    const table = lines.slice(first, last + 1);

    expect(table).toHaveLength(5);
    expect(new Set(table.map((line) => line.length)).size).toBe(1);
    expect(table[0]!.length).toBeLessThan(60);
    expect(table[1]).toMatch(/^ {2}─+$/);
    expect(table[3]).toMatch(/^ {2}─+$/);
  });

  it("stacks the session lines under the logo when they cannot sit beside it", () => {
    const lines = renderExitSummaryLines(input({ width: 56 }));
    const command = lines.find((line) => line.includes("clai --resume"))!;
    expect(command).not.toMatch(/[▄█▀]/);
    expect(command).toBe(
      `  Resume   ${resumeCommand("sess-abc123-def456")}`,
    );
    expect(lines.some((line) => line.includes("█"))).toBe(true);
  });

  it("drops the label column before it truncates the resume command", () => {
    const command = resumeCommand("sess-abc123-def456");
    const lines = renderExitSummaryLines(input({ width: 42 }));
    expect(lines.some((line) => line === `  ${command}`)).toBe(true);
    expect(plain(lines)).not.toContain("Resume  ");
  });

  it("keeps the provider prefix while it fits and drops it when it does not", () => {
    const report = reportWith([
      { provider: "nvidia", model: "openai/gpt-oss-20b" },
    ]);
    expect(plain(renderExitSummaryLines(input({ usage: report, width: 100 })))).toContain(
      "nvidia / openai/gpt-oss-20b",
    );
    const narrow = plain(
      renderExitSummaryLines(input({ usage: report, width: 52 })),
    );
    expect(narrow).not.toContain("nvidia /");
    expect(narrow).toContain("MODEL");
  });

  it("emits no ANSI escapes when color is disabled", () => {
    const text = renderExitSummary(input({ color: false }));
    expect(text).not.toMatch(/\x1b\[/);
  });

  it("colors the output when color is enabled", () => {
    const text = renderExitSummary(input({ color: true }));
    expect(text).toMatch(/\x1b\[/);
  });

  it("keeps the resume command intact and unwrapped", () => {
    const command = resumeCommand("sess-abc123-def456");
    for (const width of [120, 100, 72, 56, 40]) {
      const lines = renderExitSummaryLines(input({ width }));
      expect(
        lines.filter((line) => line.endsWith(command)),
        `width ${width}`,
      ).toHaveLength(1);
    }
  });

  it("states the session was not saved when it cannot be resumed", () => {
    const text = plain(renderExitSummaryLines(input({ resumable: false })));
    expect(text).toContain("cannot be resumed");
    expect(text).not.toContain("clai --resume");
  });

  it("reports an empty ledger without a table", () => {
    const text = plain(
      renderExitSummaryLines(input({ usage: reportWith([]) })),
    );
    expect(text).toContain("No provider token usage was recorded.");
    expect(text).not.toContain("PROVIDER / MODEL");
  });

  it("falls back to ASCII glyphs and rules without unicode", () => {
    const text = plain(renderExitSummaryLines(input({ unicode: false })));
    expect(text).toContain("######");
    expect(text).not.toContain("█");
    expect(text).not.toContain("▀");
    expect(text).not.toContain("▄");
    expect(text).not.toContain("─");
    expect(text).not.toContain("·");
    expect(text).toMatch(/^ {2}-+$/m);
  });

  it("never exceeds the terminal width at any width", () => {
    const report = reportWith([
      { provider: "openai", model: "gpt-5.4-mini" },
      {
        provider: "nvidia",
        model: "a-very-long-model-identifier/with-a-namespace-and-more",
        usage: { promptTokens: 987_654, completionTokens: 54_321, totalTokens: 1_041_975 },
      },
    ]);
    for (const width of [16, 20, 24, 32, 40, 56, 72, 80, 100, 200]) {
      for (const unicode of [true, false]) {
        const lines = renderExitSummaryLines(
          input({ usage: report, width, unicode, color: false }),
        );
        for (const line of lines) {
          expect(
            line.length,
            `width ${width} (unicode=${unicode}) produced a ${line.length}-column line: ${line}`,
          ).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("drops the cache column before the request column when narrow", () => {
    const wide = plain(renderExitSummaryLines(input({ width: 100 })));
    const narrow = plain(renderExitSummaryLines(input({ width: 34 })));
    expect(wide).toContain("CACHE");
    expect(narrow).not.toContain("CACHE");
    expect(narrow).toContain("REQ");
    expect(narrow).toContain("TOTAL");
  });

  it("shows the elapsed span and message count", () => {
    const text = plain(renderExitSummaryLines(input({ durationMs: 95_000 })));
    expect(text).toContain("8 messages");
    expect(text).toContain("1m35s");
  });

  it("omits the elapsed span when no time has passed", () => {
    const text = plain(renderExitSummaryLines(input({ durationMs: 0 })));
    expect(text).toContain("8 messages");
    expect(text).not.toContain("0.0s");
  });

  it("includes the session title when one exists", () => {
    const text = plain(
      renderExitSummaryLines(input({ title: "Add exit epilogue" })),
    );
    expect(text).toContain("Add exit epilogue");
  });

  it("marks a cache rate the provider never reported", () => {
    const text = plain(renderExitSummaryLines(input({ unicode: true })));
    expect(text).toContain("—");
  });

  it("reports the cache hit rate when the provider measured caching", () => {
    const report = reportWith([
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: { promptTokens: 1000, cachedPromptTokens: 250 },
      },
    ]);
    const text = plain(renderExitSummaryLines(input({ usage: report })));
    expect(text).toContain("25.0%");
  });
});
