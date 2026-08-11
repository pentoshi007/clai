import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function BatchBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`batch:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
