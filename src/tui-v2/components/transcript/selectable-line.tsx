/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";

export const SELECTABLE_LINE_STYLE = {
  width: "100%" as const,
  height: 1 as const,
};

export function selectableRowStyle(surface: string): {
  width: "100%";
  height: 1;
  bg: string;
} {
  return { ...SELECTABLE_LINE_STYLE, bg: surface };
}

export function SelectableLine(props: {
  content?: string | undefined;
  children?: ReactNode;
  fg?: string | undefined;
  bg?: string | undefined;
  attributes?: number | undefined;
  wrapMode?: "none" | "char" | "word" | undefined;
}): ReactNode {
  const { content, children, fg, bg, attributes, wrapMode = "none" } = props;
  if (content !== undefined) {
    return (
      <text
        content={content.length === 0 ? " " : content}
        selectable
        wrapMode={wrapMode}
        style={{
          ...SELECTABLE_LINE_STYLE,
          ...(fg ? { fg } : {}),
          ...(bg ? { bg } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
        }}
      />
    );
  }
  return (
    <text
      selectable
      wrapMode={wrapMode}
      style={{
        ...SELECTABLE_LINE_STYLE,
        ...(fg ? { fg } : {}),
        ...(bg ? { bg } : {}),
        ...(attributes !== undefined ? { attributes } : {}),
      }}
    >
      {children}
    </text>
  );
}
