import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function AssistantBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`assistant:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
