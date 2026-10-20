import { renderIntroHeaderLines } from "../../ui-core/rendering/intro-header.js";
import { CARD_BORDER_HEX } from "../../ui-core/rendering/card-style.js";
import { clipToWidth } from "../render/ansi-text.js";
import { stripAnsi } from "../render/measure.js";
import type { BlockContext } from "./block-context.js";

export interface IntroBlockInput {
  readonly version: string;
  readonly mode: string;
  readonly provider: string;
  readonly model: string;
  readonly permissions: string;
  readonly workdir: string;
  readonly variant?: string | undefined;
}

export function buildIntroLines(ctx: BlockContext, input: IntroBlockInput): string[] {
  const rendered = renderIntroHeaderLines({
    width: ctx.width,
    version: input.version,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
    permissions: input.permissions,
    workdir: input.workdir,
    variant: input.variant,
    paintBorder: (text) => ctx.ink.hex(CARD_BORDER_HEX, text),
    theme: ctx.ink.theme,
  });
  const plain = ctx.ink.colorMode === "none";
  return rendered.map((line) =>
    clipToWidth(plain ? stripAnsi(line) : line, ctx.width, ""),
  );
}
