import { Box, Static, Text } from "ink";
import type { ReactNode } from "react";
import { BlockView } from "./Feed.js";
import type { FeedBlock } from "./feed-blocks.js";

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
