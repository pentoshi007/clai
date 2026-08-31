
import { renderStyledMarkdownLines } from "./styled-markdown.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { looksLikeMarkdown } from "../../ui-core/rendering/pager-source.js";

export type PagerMarkdownMode = "auto" | "force" | "plain";

export type PagerStyledLine = ReturnType<typeof renderStyledMarkdownLines>[number];

export interface PagerDisplayLine {
  readonly plain: string;
  readonly styled?: PagerStyledLine | undefined;
}

export interface PreparePagerDisplayOptions {
  readonly body: string;
  readonly width: number;
  readonly mode?: PagerMarkdownMode | undefined;
  readonly defaultFg?: string | undefined;
}

function plainLines(body: string): PagerDisplayLine[] {
  const raw = body.replace(/\n+$/, "");
  if (!raw) return [{ plain: " " }];
  return raw.split("\n").map((line) => ({ plain: line.length === 0 ? " " : line }));
}

export function preparePagerDisplay(
  options: PreparePagerDisplayOptions,
): { readonly mode: "markdown" | "plain"; readonly lines: readonly PagerDisplayLine[] } {
  const mode = options.mode ?? "auto";
  const body = options.body ?? "";
  const width = Math.max(24, options.width);

  if (mode === "plain") {
    return { mode: "plain", lines: plainLines(body) };
  }

  const wantMarkdown =
    mode === "force" || (mode === "auto" && looksLikeMarkdown(body));

  if (!wantMarkdown) {
    return { mode: "plain", lines: plainLines(body) };
  }

  try {
    const styled = renderStyledMarkdownLines(body, {
      width,
      defaultFg: options.defaultFg,
      stripOuterIndent: true,
    });
    if (styled.length === 0) {
      return { mode: "plain", lines: plainLines(body) };
    }
    const lines: PagerDisplayLine[] = styled.map((st) => {
      const joined = st.chunks.map((c) => c.text).join("");
      const plain = sanitizeDisplayText(joined) || " ";
      return { plain, styled: st };
    });
    return { mode: "markdown", lines };
  } catch {
    return { mode: "plain", lines: plainLines(body) };
  }
}
