import { createElement, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { useClickWithoutDrag } from "../transcript/use-click-without-drag.js";

export function JumpToLatest(props: {
  readonly label: string;
  readonly theme: Theme;
  readonly onJump: () => void;
}): ReactNode {
  const { label, theme, onJump } = props;
  const click = useClickWithoutDrag(onJump);
  return createElement("text", {
    id: "jump-to-latest",
    selectable: false,
    wrapMode: "none",
    onMouseDown: click.onMouseDown,
    onMouseUp: click.onMouseUp,
    style: { height: 1, flexShrink: 0, fg: theme.cyan, bg: theme.chip, attributes: TextAttributes.BOLD },
  }, label);
}
