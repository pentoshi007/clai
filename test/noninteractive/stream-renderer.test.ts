import { describe, expect, it } from "vitest";
import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { fakeClock, fakeStream, FIXTURE_OUTCOME, scriptedEvents } from "./fixture.js";

function run(
  overrides: Partial<{
    color: boolean;
    unicode: boolean;
    verbosity: "quiet" | "normal" | "verbose";
    showThinking: boolean;
    columns: number;
    tty: boolean;
  }> = {},
) {
  const out = fakeStream(overrides.tty ?? false);
  const err = fakeStream(overrides.tty ?? false);
  const renderer = new StreamRenderer(
    {
      out,
      err,
      columns: overrides.columns ?? 80,
      color: overrides.color ?? false,
      unicode: overrides.unicode ?? true,
      verbosity: overrides.verbosity ?? "normal",
      showThinking: overrides.showThinking ?? true,
    },
    fakeClock(),
  );
  for (const event of scriptedEvents()) renderer.handle(event);
  renderer.finish(FIXTURE_OUTCOME);
  return { out, err };
}

describe("StreamRenderer", () => {
  it("writes the scripted turn as exact stdout and stderr transcripts", () => {
    const { out, err } = run();
    expect(out.text()).toBe(
      ["◆ I'll search your home directory.", "◆ Found 6 PDFs over 100 MB.", ""].join("\n"),
    );
    expect(err.text()).toBe(
      [
        "│ I should search the home directory.",
        "● shell.exec(find ~ -name '*.pdf')",
        "  └ atlas.pdf",
        "    scan.pdf",
        "    report.pdf",
        "    … +1 line",
        "✓ done · 2.4s",
        "● shell.exec(du -sh missing)",
        "✗ failed · 1 · 2.4s",
        "    du: missing: No such file",
        "⊘ fs.delete blocked",
        "    confirmation required",
        "● fs.edit",
        "✓ Edited app.ts                                                          +2 −1",
        "  file  /repo/src/app.ts",
        "● tool.batch(2 calls)",
        "  ✓ shell.exec                                                   done (exit 0)",
        "  ✗ fs.read                                                    failed (exit 1)",
        "  1 failed / 2 sub-tool(s)",
        "✗ failed · 2.4s",
        "    1 of 2 failed",
        "✦ compacting context · ~120,000 tokens before",
        "✦ compacted context · ~120,000 → ~30,000 tokens",
        "⊘ aborted",
        "",
      ].join("\n"),
    );
  });

  it("never writes a cursor or erase sequence to stdout", () => {
    const { out } = run({ color: true, tty: true });
    expect(out.text()).not.toContain("\r");
    expect(out.text()).not.toMatch(/\x1b\[[0-9;]*[A-HJKSTf]/);
  });

  it("writes the outcome exactly once", () => {
    const out = fakeStream();
    const err = fakeStream();
    const renderer = new StreamRenderer(
      { out, err, columns: 80, color: false, unicode: true, verbosity: "normal", showThinking: false },
      fakeClock(),
    );
    const outcome = createTurnOutcome({
      status: "failed",
      answer: "partial work",
      steps: 2,
      remainingCriteria: ["verify build"],
      reason: "tool failed",
    });
    renderer.finish(outcome);
    renderer.finish(outcome);
    expect(out.chunks).toHaveLength(1);
    expect(out.text()).toContain("Status: failed");
    expect(out.text()).toContain("Remaining:");
  });

  it("omits thinking rows unless showThinking is set", () => {
    const { err } = run({ showThinking: false });
    expect(err.text()).not.toContain("I should search");
  });

  it("emits only the answer under quiet", () => {
    const { out, err } = run({ verbosity: "quiet" });
    expect(err.text()).toBe("");
    expect(out.text()).toContain("Found 6 PDFs");
  });

  it("shows diff hunks and status rows under verbose", () => {
    const { err } = run({ verbosity: "verbose" });
    expect(err.text()).toContain("const c = 4;");
    expect(err.text()).toContain("step 1");
  });
});
