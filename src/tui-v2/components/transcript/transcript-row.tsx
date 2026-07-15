/** @jsxImportSource @opentui/react */
/**
 * Dispatches one normalized item to its renderer (V2-051..055).
 *
 * The only place that switches on `item.kind`; adding an item kind means
 * adding one case here plus its renderer, not touching a scattered UI switch
 * (ARCHITECTURE "commands are data plus handlers, not switch statements").
 */

import type { ReactNode } from "react";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { TranscriptStore } from "../../state/transcript-store.js";
import { isItemExpanded, type TranscriptItem, type TranscriptState } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { UserMessage } from "./user-message.js";
import { AssistantMessage } from "./assistant-message.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCard } from "./tool-card.js";
import { NoticeRow } from "./notice-row.js";
import { CompactedRow } from "./compacted-row.js";

export function TranscriptRow(props: {
  item: TranscriptItem;
  state: TranscriptState;
  theme: Theme;
  store: TranscriptStore;
  spool: OutputSpool;
  services: AppServices;
  onOpenUserPrompt: (prompt: string) => void;
  /** Chat-pane columns so markdown tables reflow beside the plan pane. */
  contentWidth?: number | undefined;
}): ReactNode {
  const {
    item,
    state,
    theme,
    store,
    spool,
    services,
    onOpenUserPrompt,
    contentWidth,
  } = props;
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} theme={theme} onOpen={onOpenUserPrompt} />;
    case "assistant":
      return (
        <AssistantMessage
          item={item}
          theme={theme}
          contentWidth={contentWidth}
        />
      );
    case "thinking":
      return (
        <ThinkingBlock
          item={item}
          theme={theme}
          expanded={isItemExpanded(state, item)}
          onToggle={() => store.toggleItemOverride(item.id, state.expandThinkingGlobal)}
        />
      );
    case "tool":
      return (
        <ToolCard
          item={item}
          theme={theme}
          spool={spool}
          services={services}
          expanded={isItemExpanded(state, item)}
          onToggle={() => store.toggleItemOverride(item.id, state.expandOutputGlobal)}
        />
      );
    case "notice":
      return <NoticeRow item={item} theme={theme} />;
    case "compacted":
      return (
        <CompactedRow
          item={item}
          theme={theme}
          contentWidth={contentWidth}
          expanded={isItemExpanded(state, item)}
          onToggle={() =>
            store.toggleItemOverride(item.id, state.expandOutputGlobal)
          }
        />
      );
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}
