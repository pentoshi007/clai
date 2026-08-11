import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function CompactedBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`compacted:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
