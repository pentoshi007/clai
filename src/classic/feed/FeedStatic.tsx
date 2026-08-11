import { Box, Static, Text } from "ink";
import type { ReactNode } from "react";
import { BlockView } from "./Feed.js";
import type { FeedBlock } from "./feed-blocks.js";

/**
 * The only mechanism in the product allowed to produce scrollback. Items are
 * append-only; Ink writes each one exactly once and never rewrites it, which is
 * why `commit-ledger.ts` must never un-commit a block.
 *
 * One trailing blank row per block supplies the inter-block gap from
 * 04-UI-SPEC §1 without any block emitting its own trailing blank.
 */
export function FeedStatic(props: { readonly committed: readonly FeedBlock[] }): ReactNode {
  return (
    <Static items={props.committed as FeedBlock[]}>
      {(block) => (
        <Box key={block.key} flexDirection="column" flexShrink={0}>
          <BlockView block={block} />
          <Text wrap="truncate"> </Text>
        </Box>
      )}
    </Static>
  );
}
