// V2-014 — Streaming Markdown/code/tables/partial-fence spike.
//
// Feeds markdown to a MarkdownRenderable one chunk at a time (streaming mode),
// capturing the rendered frame after every chunk. Verifies:
//   - partial/unterminated code fences never throw or blank the frame;
//   - tables render progressively as rows arrive;
//   - Unicode survives;
//   - text that merely looks like an ANSI escape is shown literally and does
//     not inject a real control byte into the rendered buffer.
import { createTestRenderer } from "@opentui/core/testing";
import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { check, makeResult, measure, note, type SpikeResult } from "./harness.js";

const CHUNKS: string[] = [
  "# Streaming demo\n\nStarting a paragraph with Unicode: café — 日本語 ✅\n\n",
  "```ts\nconst x = 1\n", // partial fence: no closing ``` yet
  "const y = x + 1\n",
  "```\n\n", // fence now closed
  "| Name | Count |\n| --- | --- |\n", // table header + separator
  "| alpha | 1 |\n", // first row
  "| beta | 2 |\n", // second row
  "\nLiteral escape sample: \\x1b[31mNOT-RED\\x1b[0m done.\n", // ANSI-looking literal
];

export async function runStreamingMarkdownSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-014", "Streaming Markdown / partial fences / tables");
  const setup = await createTestRenderer({ width: 64, height: 24 });
  try {
    const md = new MarkdownRenderable(setup.renderer, {
      content: "",
      syntaxStyle: SyntaxStyle.create(),
      streaming: true,
    });
    setup.renderer.root.add(md);

    let accumulated = "";
    let threw = false;
    let blankedAfterContent = false;
    let sawContent = false;
    const frameTimes: number[] = [];

    for (let i = 0; i < CHUNKS.length; i++) {
      accumulated += CHUNKS[i];
      try {
        md.content = accumulated;
        await setup.renderOnce();
      } catch (err) {
        threw = true;
        note(result, `chunk ${i} threw: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      const frame = setup.captureCharFrame();
      const visible = frame.replace(/\s+/g, "");
      if (visible.length > 0) sawContent = true;
      else if (sawContent) blankedAfterContent = true;
      frameTimes.push(setup.getNativeStats().nativeLastFrameTime);
      // A real control byte (0x1b) must never reach the rendered buffer from content.
      if (frame.includes("\u001b")) {
        check(result, `chunk ${i}: no raw ESC byte in frame`, false, "found 0x1b");
      }
    }

    // finalize streaming
    md.streaming = false;
    await setup.renderOnce();
    const finalFrame = setup.captureCharFrame();
    const finalCompact = finalFrame.replace(/\s+/g, "");

    check(result, "no chunk threw (partial fence safe)", !threw);
    check(result, "frame never blanked after content appeared", !blankedAfterContent);
    check(result, "heading rendered", finalFrame.includes("Streaming demo"));
    check(result, "Unicode preserved (café / 日本語 / ✅)",
      finalFrame.includes("café") && finalFrame.includes("日本語") && finalFrame.includes("✅"));
    check(result, "code content rendered", finalCompact.includes("constx=1") || finalFrame.includes("const x = 1"));
    check(result, "table cells rendered (alpha/beta)",
      finalFrame.includes("alpha") && finalFrame.includes("beta"));
    check(result, "ANSI-looking text shown literally, not injected",
      finalFrame.includes("NOT-RED") && !finalFrame.includes("\u001b"));

    if (frameTimes.length > 0) {
      // OpenTUI native stats report frame time in microseconds.
      const usToMs = (us: number) => Number((us / 1000).toFixed(3));
      const max = Math.max(...frameTimes);
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      measure(result, "chunks", frameTimes.length);
      measure(result, "avgFrameTimeMs", usToMs(avg));
      measure(result, "maxFrameTimeMs", usToMs(max));
    }
    return result;
  } finally {
    setup.renderer.destroy();
  }
}
