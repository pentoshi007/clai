import { describe, expect, it } from "vitest";
import { buildAssistantLines } from "../../../src/classic/blocks/assistant-lines.js";
import { EMPTY_SPOOL, type BlockContext } from "../../../src/classic/blocks/block-context.js";
import { glyphsFor } from "../../../src/classic/render/glyphs.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

function context(): BlockContext {
  return {
    width: 80,
    ink,
    glyphs: glyphsFor(true),
    now: 0,
    state: EMPTY_TRANSCRIPT_STATE,
    spool: EMPTY_SPOOL,
    markdownCache: undefined,
  };
}

function render(text: string): string[] {
  return buildAssistantLines(context(), {
    kind: "assistant",
    text,
    streaming: false,
  } as never).lines;
}

const RESPONSE_OPEN = ink.fg("response", "X").split("X")[0]!;

describe("assistant text colour", () => {
  it("paints plain prose in the response colour", () => {
    expect(render("plain prose only")[0]).toContain(`${RESPONSE_OPEN}plain prose only`);
  });

  it("keeps plain segments in the response colour after an inline code span", () => {
    const line = render("run `npm test` then read the output")[0]!;
    const tail = line.slice(line.indexOf("npm test"));
    expect(tail).toContain(`${RESPONSE_OPEN} then read the output`);
  });

  it("treats lines with and without inline styling the same way", () => {
    const plain = render("alpha beta")[0]!;
    const mixed = render("alpha `code` beta")[0]!;
    expect(plain).toContain(`${RESPONSE_OPEN}alpha`);
    expect(mixed).toContain(`${RESPONSE_OPEN}alpha`);
  });
});
