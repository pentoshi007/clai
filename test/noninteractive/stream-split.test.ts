import { describe, expect, it } from "vitest";
import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { stripAnsi } from "../../src/classic/render/measure.js";
import { fakeClock, fakeStream, FIXTURE_OUTCOME, scriptedEvents } from "./fixture.js";

const PROGRESS_MARKERS = [
  "I should search the home directory.",
  "shell.exec",
  "fs.delete",
  "Edited app.ts",
  "tool.batch",
  "compacting context",
  "compacted context",
  "aborted",
] as const;

describe("stdout / stderr split", () => {
  const out = fakeStream();
  const err = fakeStream();
  const renderer = new StreamRenderer(
    {
      out,
      err,
      columns: 80,
      color: false,
      unicode: true,
      verbosity: "verbose",
      showThinking: true,
    },
    fakeClock(),
  );
  for (const event of scriptedEvents()) renderer.handle(event);
  renderer.finish(FIXTURE_OUTCOME);

  const stdout = stripAnsi(out.text());
  const stderr = stripAnsi(err.text());

  it("puts the answer on stdout only", () => {
    expect(stdout).toContain("Found 6 PDFs over 100 MB.");
    expect(stderr).not.toContain("Found 6 PDFs over 100 MB.");
  });

  it("puts every progress line on stderr only", () => {
    for (const marker of PROGRESS_MARKERS) {
      expect(stderr, marker).toContain(marker);
      expect(stdout, marker).not.toContain(marker);
    }
  });

  it("keeps stdout to assistant rows", () => {
    for (const line of stdout.split("\n").filter((l) => l.length > 0)) {
      expect(line.startsWith("◆ ") || line.startsWith("  ")).toBe(true);
    }
  });
});
