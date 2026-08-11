import { describe, expect, it } from "vitest";
import { StreamSpinner } from "../../src/noninteractive/stream-spinner.js";
import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { fakeClock, fakeStream, FIXTURE_OUTCOME } from "./fixture.js";

describe("StreamSpinner", () => {
  it("writes a single rewritten line when stderr is a TTY", () => {
    const err = fakeStream(true);
    const spinner = new StreamSpinner({ err, columns: 40, unicode: true });
    spinner.tick("waiting for model");
    spinner.tick("tool: shell.exec");
    expect(spinner.isActive).toBe(true);
    expect(err.chunks).toEqual(["\r\x1b[K⠋ waiting for model", "\r\x1b[K⠙ tool: shell.exec"]);
    expect(err.text()).not.toContain("\n");
  });

  it("writes nothing when stderr is not a TTY", () => {
    const err = fakeStream(false);
    const spinner = new StreamSpinner({ err, columns: 40, unicode: true });
    spinner.tick("waiting for model");
    spinner.clear();
    expect(spinner.isActive).toBe(false);
    expect(err.chunks).toEqual([]);
  });

  it("clears with \\r\\x1b[K and is safe when inactive or already cleared", () => {
    const err = fakeStream(true);
    const spinner = new StreamSpinner({ err, columns: 40, unicode: true });
    spinner.clear();
    expect(err.chunks).toEqual([]);
    spinner.tick("busy");
    spinner.clear();
    spinner.clear();
    expect(err.chunks.at(-1)).toBe("\r\x1b[K");
    expect(err.chunks).toHaveLength(2);
  });

  it("clips the line to the terminal width and degrades to ASCII frames", () => {
    const err = fakeStream(true);
    new StreamSpinner({ err, columns: 12, unicode: false }).tick("waiting for the model");
    expect(err.chunks[0]).toBe("\r\x1b[K- waiting f");
  });
});

describe("spinner and stream interleaving", () => {
  it("clears itself before a stdout write", () => {
    const out = fakeStream(true);
    const err = fakeStream(true);
    const renderer = new StreamRenderer(
      {
        out,
        err,
        columns: 80,
        color: false,
        unicode: true,
        verbosity: "normal",
        showThinking: false,
      },
      fakeClock(),
    );
    renderer.handle({ type: "status", text: "step 1" });
    renderer.handle({ type: "assistant-message", text: "hello" });
    expect(err.chunks.at(-1)).toBe("\r\x1b[K");
    expect(out.chunks).toEqual(["◆ hello\n"]);
  });

  it("clears itself before the final outcome write", () => {
    const out = fakeStream(true);
    const err = fakeStream(true);
    const renderer = new StreamRenderer(
      {
        out,
        err,
        columns: 80,
        color: false,
        unicode: true,
        verbosity: "normal",
        showThinking: false,
      },
      fakeClock(),
    );
    renderer.handle({ type: "status", text: "step 1" });
    renderer.finish(FIXTURE_OUTCOME);
    expect(err.chunks.at(-1)).toBe("\r\x1b[K");
  });

  it("stays silent when the surface is quiet", () => {
    const out = fakeStream(true);
    const err = fakeStream(true);
    const renderer = new StreamRenderer(
      {
        out,
        err,
        columns: 80,
        color: false,
        unicode: true,
        verbosity: "quiet",
        showThinking: false,
      },
      fakeClock(),
    );
    renderer.handle({ type: "status", text: "step 1" });
    renderer.finish(FIXTURE_OUTCOME);
    expect(err.chunks).toEqual([]);
  });
});
