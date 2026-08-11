import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function ToolBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`tool:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
