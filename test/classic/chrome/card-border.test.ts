import { describe, expect, it } from "vitest";
import { composerTopBorder } from "../../../src/classic/chrome/Composer.js";
import { composerFrame } from "../../../src/classic/chrome/composer-frame.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { buildIntroLines } from "../../../src/classic/blocks/intro-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";

const options = {
  width: 80,
  version: "1.2.3",
  mode: "agent",
  provider: "openai",
  model: "test-model",
  permissions: "default",
  workdir: "~/project",
};

describe("classic composer card border", () => {
  it.each(["dark", "light"] as const)("matches the startup border in the %s theme for every phase", (themeHint) => {
    for (const colorMode of ["truecolor", "256", "16", "none"] as const) {
      const ink = createInkTheme({ themeHint, colorMode, unicode: true });
      const ctx = blockContextFor(EMPTY_TRANSCRIPT_STATE, { columns: 80, ink, now: 0, generation: 0 });
      const card = buildIntroLines(ctx, options).find((line) => line.includes("╭"))!;
      const probe = ink.hex("#2EEBFF", "╭");
      const color = probe.slice(0, probe.indexOf("╭"));
      expect(card).toContain(`${color}╭`);
      for (const phase of ["idle", "running", "suspended"] as const) {
        const frame = composerFrame({ columns: 78, allocatedRows: 3, text: "", mode: "agent", phase, unicode: true });
        expect(composerTopBorder(ink, frame)).toContain(`${color}╭`);
        expect(frame.borderColor).toBe("#2EEBFF");
      }
    }
  });

  it("keeps a plain-text border on terminals without colors", () => {
    const ink = createInkTheme({ themeHint: "light", colorMode: "none", unicode: true });
    const frame = composerFrame({ columns: 78, allocatedRows: 3, text: "", mode: "agent", phase: "idle", unicode: true });
    expect(composerTopBorder(ink, frame)).not.toContain("\x1b");
  });
});
