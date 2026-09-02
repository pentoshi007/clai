import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { clipToWidth, padToWidth } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import type { ComposerFrame } from "./composer-frame.js";
import type { EditorState } from "./editor-model.js";
import {
  layoutEditor,
  renderEditor,
  scrollTop,
  type EditorSpan,
} from "./editor-view.js";

export interface ComposerProps {
  readonly ink: InkTheme;
  readonly frame: ComposerFrame;
  readonly state: EditorState;
  readonly scrollTop?: number | undefined;
  readonly onScrollTop?: ((top: number) => void) | undefined;
  readonly accentSpans?: readonly EditorSpan[] | undefined;
}

export function composerTopBorder(ink: InkTheme, frame: ComposerFrame): string {
  const glyphs = ink.glyphs;
  const inner = Math.max(0, frame.width - 2);
  const paint = (text: string): string => ink.fg(frame.borderColor, text);
  if (inner === 0) return paint(`${glyphs.boxTopLeft}${glyphs.boxTopRight}`);
  const meta = clipToWidth(frame.meta, Math.max(0, inner - 4), "");
  if (meta === "") {
    return paint(
      `${glyphs.boxTopLeft}${glyphs.rule.repeat(inner)}${glyphs.boxTopRight}`,
    );
  }
  const title = ` ${meta} `;
  const leftRules = Math.max(1, inner - layoutWidth(title) - 1);
  const rightRules = Math.max(1, inner - layoutWidth(title) - leftRules);
  return (
    paint(glyphs.boxTopLeft + glyphs.rule.repeat(leftRules)) +
    ink.fg("muted", title) +
    paint(glyphs.rule.repeat(rightRules) + glyphs.boxTopRight)
  );
}

function bottomBorder(ink: InkTheme, frame: ComposerFrame): string {
  const glyphs = ink.glyphs;
  const inner = Math.max(0, frame.width - 2);
  return ink.fg(
    frame.borderColor,
    `${glyphs.boxBottomLeft}${glyphs.rule.repeat(inner)}${glyphs.boxBottomRight}`,
  );
}

export function Composer(props: ComposerProps): ReactNode {
  const { ink, frame, state } = props;
  const layout = layoutEditor(state, frame.textWidth);
  const top = scrollTop(layout, frame.textRows, props.scrollTop ?? 0);
  if (props.onScrollTop && top !== props.scrollTop) props.onScrollTop(top);

  const rendered = renderEditor({
    state,
    layout,
    ink,
    height: frame.textRows,
    scrollTop: top,
    showCaret: frame.showCaret,
    placeholder: state.text.length === 0 ? frame.placeholder : undefined,
    ...(props.accentSpans ? { accentSpans: props.accentSpans } : {}),
  });

  const glyphs = ink.glyphs;
  const vertical = ink.fg(frame.borderColor, glyphs.boxVertical);

  return (
    <Box flexDirection="column" width={frame.width} flexShrink={0}>
      <Text wrap="truncate">{composerTopBorder(ink, frame)}</Text>
      {rendered.rows.map((row, index) => {
        const clipped =
          (index === 0 && rendered.clippedAbove) ||
          (index === rendered.rows.length - 1 && rendered.clippedBelow);
        const mark =
          index === 0 ? ink.fg(frame.markColor, `${frame.mark} `) : "  ";
        const text = padToWidth(row, frame.textWidth);
        const clipMark = ink.dim(clipped ? glyphs.clip : " ");
        const inner = padToWidth(`${mark}${text}${clipMark}`, frame.width - 2);
        return (
          <Text key={`composer-row-${index}`} wrap="truncate">
            {`${vertical}${inner}${vertical}`}
          </Text>
        );
      })}
      <Text wrap="truncate">{bottomBorder(ink, frame)}</Text>
    </Box>
  );
}