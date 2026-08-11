import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function UserBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`user:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
