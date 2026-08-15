import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AssistantBlock } from "../blocks/AssistantBlock.js";
import { BatchBlock } from "../blocks/BatchBlock.js";
import { CompactedBlock } from "../blocks/CompactedBlock.js";
import { DiffBlock } from "../blocks/DiffBlock.js";
import { IntroBlock } from "../blocks/IntroBlock.js";
import { NoticeBlock } from "../blocks/NoticeBlock.js";
import { ThinkingBlock } from "../blocks/ThinkingBlock.js";
import { ToolBlock } from "../blocks/ToolBlock.js";
import { TurnSummaryBlock } from "../blocks/TurnSummaryBlock.js";
import { UserBlock } from "../blocks/UserBlock.js";
import type { BlockKind, FeedBlock } from "./feed-blocks.js";

export interface BlockViewProps {
  readonly block: FeedBlock;
  /** Rows to render; defaults to every line the block carries. */
  readonly lines?: readonly string[] | undefined;
}

/**
 * The single row primitive. Lines are already exact-width ANSI, so Ink is told
 * not to wrap: a wrap here would silently break the exact-height contract.
 */
export function BlockRows(props: {
  readonly id: string;
  readonly lines: readonly string[];
}): ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.lines.map((line, index) => (
        <Text key={`${props.id}:${index}`} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

const BLOCK_COMPONENTS: Record<BlockKind, (props: BlockViewProps) => ReactNode> = {
  intro: IntroBlock,
  user: UserBlock,
  assistant: AssistantBlock,
  thinking: ThinkingBlock,
  tool: ToolBlock,
  batch: BatchBlock,
  diff: DiffBlock,
  compacted: CompactedBlock,
  notice: NoticeBlock,
  "turn-summary": TurnSummaryBlock,
};

export function blockComponentFor(kind: BlockKind): (props: BlockViewProps) => ReactNode {
  return BLOCK_COMPONENTS[kind];
}

export function BlockView(props: BlockViewProps): ReactNode {
  const Component = blockComponentFor(props.block.kind);
  return <Component {...props} />;
}
