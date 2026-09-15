import { Chalk } from "chalk";
import type { ColorMode } from "../../app/ports/terminal-port.js";
import { CHALK_LEVEL } from "../../ui-core/rendering/markdown.js";
import type { Theme } from "../../ui-core/rendering/theme.js";
import type { SubagentSpan } from "../../ui-core/rendering/subagent-presentation.js";

export function subagentAnsiPaint(
  theme: Theme,
  colorMode: ColorMode,
): (span: SubagentSpan) => string {
  const paint = new Chalk({ level: CHALK_LEVEL[colorMode] });
  return (span) => {
    const colored = paint.hex(theme[span.fg]);
    return span.bold ? colored.bold(span.text) : colored(span.text);
  };
}
