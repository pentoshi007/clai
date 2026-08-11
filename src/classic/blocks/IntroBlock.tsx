import type { ReactNode } from "react";
import { BlockRows, type BlockViewProps } from "../feed/Feed.js";

export function IntroBlock(props: BlockViewProps): ReactNode {
  return (
    <BlockRows
      id={`intro:${props.block.key}`}
      lines={props.lines ?? props.block.lines}
    />
  );
}
