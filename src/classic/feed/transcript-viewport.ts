import type { FeedBlock } from "./feed-blocks.js";
import {
  offsetForTranscriptAnchor,
  planTranscriptWindow,
  type TranscriptRowAnchor,
  type TranscriptWindow,
} from "./transcript-window.js";

export interface TranscriptViewportInput {
  readonly columns: number;
  readonly generation: number;
  readonly navigationVersion: number;
  readonly offset: number;
}

interface ViewportAnchor extends TranscriptViewportInput {
  readonly row: TranscriptRowAnchor | undefined;
  readonly following: boolean;
}

export class TranscriptViewport {
  private previous: ViewportAnchor | undefined;

  plan(blocks: readonly FeedBlock[], budget: number, input: TranscriptViewportInput): TranscriptWindow {
    const previous = this.previous;
    const stationary = previous !== undefined
      && previous.columns === input.columns
      && previous.generation === input.generation
      && previous.navigationVersion === input.navigationVersion;
    const following = stationary ? previous.following : input.offset === 0;
    const anchoredOffset = stationary && !following && previous.row
      ? offsetForTranscriptAnchor(blocks, budget, previous.row)
      : undefined;
    let offset = input.offset;
    if (following) offset = 0;
    else if (budget > 0) offset = anchoredOffset ?? offset;
    const window = planTranscriptWindow(blocks, budget, offset);
    const first = window.rows[0];
    let row = first ? { blockKey: first.block.key, lineIndex: first.lineIndex } : undefined;
    if (stationary && previous.row && (budget <= 0 || anchoredOffset !== undefined)) row = previous.row;
    this.previous = { ...input, following, row };
    return window;
  }
}
