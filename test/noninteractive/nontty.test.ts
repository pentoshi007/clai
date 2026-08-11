import { describe, expect, it } from "vitest";
import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { fakeClock, fakeStream, FIXTURE_OUTCOME, scriptedEvents } from "./fixture.js";

function nonTtyRun() {
  const out = fakeStream(false);
  const err = fakeStream(false);
  const renderer = new StreamRenderer(
    {
      out,
      err,
      columns: 80,
      color: false,
      unicode: false,
      verbosity: "normal",
      showThinking: true,
    },
    fakeClock(),
  );
  for (const event of scriptedEvents()) renderer.handle(event);
  renderer.finish(FIXTURE_OUTCOME);
  return { stdout: out.text(), stderr: err.text() };
}

describe("non-TTY byte stream", () => {
  const { stdout, stderr } = nonTtyRun();

  it("contains no ANSI byte", () => {
    expect(stdout).not.toContain("\x1b");
    expect(stderr).not.toContain("\x1b");
  });

  it("contains no carriage return", () => {
    expect(stdout).not.toContain("\r");
    expect(stderr).not.toContain("\r");
  });

  it("uses plain [tool] prefixes instead of glyphs", () => {
    expect(stderr).toContain("[tool] shell.exec(find ~ -name '*.pdf')");
    expect(stderr).toContain("[ok] done");
    expect(stderr).toContain("[blocked] fs.delete blocked");
    expect(stderr).not.toMatch(/[●✓✗⊘◆✦│]/u);
    expect(stdout).not.toMatch(/[●✓✗⊘◆✦│]/u);
  });

  it("stays line oriented and parseable", () => {
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stderr.endsWith("\n")).toBe(true);
    for (const line of stderr.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
  });
});
