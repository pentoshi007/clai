import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function NoticeBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`notice:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
