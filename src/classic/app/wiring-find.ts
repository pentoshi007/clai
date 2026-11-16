import { notify } from "../../ui-core/notify.js";
import type { FeedMatch, FeedMatchPosition } from "../feed/feed-search.js";
import { offsetForFeedMatch } from "../feed/feed-search.js";
import { TranscriptFind } from "../feed/transcript-find.js";
import type { WiringHost } from "./wiring-types.js";

function viewAnchor(host: WiringHost): FeedMatchPosition | undefined {
  const rows = host.selectionWindow?.rows ?? [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.lineIndex === undefined) continue;
    const blockIndex = host.feedBlocks.findIndex((block) => block.key === row.block.key);
    if (blockIndex >= 0) return { blockIndex, lineIndex: row.lineIndex, start: Number.MAX_SAFE_INTEGER };
  }
  return undefined;
}

function revealFeedMatch(host: WiringHost, match: FeedMatch): void {
  const budget = host.feedViewportRows || host.selectionWindow?.viewportRows || Math.max(1, Math.floor(host.rows / 2));
  const offset = offsetForFeedMatch(host.feedBlocks, budget, match);
  if (offset === undefined) return;
  host.wheel.stop();
  host.services.selection.clear();
  host.liveOffsetValue = offset;
  host.feedNavigationVersion += 1;
  host.schedulePaint(true);
}

export function createTranscriptFind(host: WiringHost): TranscriptFind {
  return new TranscriptFind({
    focus: host.services.focus,
    blocks: () => host.feedBlocks,
    anchor: () => viewAnchor(host),
    reveal: (match) => revealFeedMatch(host, match),
    notify: (text, level = "info") => notify(host.services, text, { key: "find", level, durationMs: 1400 }),
  });
}

export function routePaste(host: WiringHost, text: string): void {
  if (host.find.paste(text)) return;
  if (host.panels.isOpen()) {
    host.panels.handlePaste(text);
    return;
  }
  host.services.focus.focusRegion("composer");
  host.composer.paste(text);
}
