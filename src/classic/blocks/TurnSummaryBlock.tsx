import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function TurnSummaryBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`turn-summary:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
