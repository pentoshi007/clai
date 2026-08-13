import { homedir } from "node:os";
import { useMemo, useRef } from "react";
import { getCurrentVersion } from "../../commands/update.js";
import { safeCwd } from "../../os/cwd.js";
import { getConfig } from "../../store/config.js";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";
import type { IntroBlockInput } from "../blocks/intro-lines.js";
import type { BlockContext } from "../blocks/block-context.js";
import { blockContextFor, buildFeedBlocks, type FeedBlock } from "../feed/feed-blocks.js";
import {
  flattenBlocks,
  planTranscriptWindow,
  type TranscriptWindow,
} from "../feed/transcript-window.js";
import { createInkTheme, type InkTheme } from "../render/ink-theme.js";

export interface FeedSnapshot {
  readonly ink: InkTheme;
  readonly context: BlockContext;
  readonly blocks: readonly FeedBlock[];
  readonly window: TranscriptWindow;
  /** Shell width + generation the window geometry was computed for. */
  readonly columns: number;
  readonly generation: number;
}

function displayWorkdir(workdir: string): string {
  const home = homedir();
  return workdir.startsWith(home) ? `~${workdir.slice(home.length)}` : workdir;
}

export function introInputFor(services: AppServices): IntroBlockInput {
  const session = services.session.getState();
  const cfg = getConfig();
  return {
    version: getCurrentVersion(),
    mode: session.mode,
    provider: session.provider ?? cfg.defaultProvider,
    model: session.model ?? cfg.defaultModel,
    permissions: cfg.permissions ?? "default",
    workdir: displayWorkdir(safeCwd()),
    variant: cfg.thinking.enabled ? cfg.thinking.effort : "off",
  };
}

export function useInkTheme(services: AppServices): InkTheme {
  const { colorMode, unicode, themeHint } = services.capabilities;
  return useMemo(
    () => createInkTheme({ themeHint, colorMode, unicode }),
    [themeHint, colorMode, unicode],
  );
}

export interface FeedLedgerState {
  generation: number;
  committedCount: number;
  consumedBoundaryToken: number;
}

export interface UseFeedInput {
  readonly services: AppServices;
  readonly state: TranscriptState;
  readonly columns: number;
  readonly liveBudgetRows: number;
  readonly now: number;
  readonly generation: number;
  /** Rows hidden below the viewport; `0` pins the window to the newest row. */
  readonly liveOffset: number;
  readonly intro: IntroBlockInput | undefined;
}

/**
 * Projects transcript state onto one virtualized scroll page: the intro card
 * is the first block and the whole page renders through a line-exact window
 * anchored `liveOffset` rows above the bottom — the OpenTUI scrollbox model.
 */
export function useFeed(input: UseFeedInput): FeedSnapshot {
  const state = input.state;
  const ink = useInkTheme(input.services);

  const view = useMemo(
    () => ({
      columns: input.columns,
      ink,
      now: input.now,
      spool: input.services.session.spool,
      generation: input.generation,
      intro: input.intro,
    }),
    [input.columns, input.generation, input.intro, input.now, input.services.session.spool, ink],
  );
  const context = useMemo(() => blockContextFor(state, view), [state, view]);
  const blocks = useMemo(() => buildFeedBlocks(state, view), [state, view]);
  const flat = useMemo(() => flattenBlocks(blocks), [blocks]);
  const window = useMemo(
    () => planTranscriptWindow(flat, input.liveBudgetRows, input.liveOffset),
    [flat, input.liveBudgetRows, input.liveOffset],
  );

  return { ink, context, blocks, window, columns: input.columns, generation: input.generation };
}
