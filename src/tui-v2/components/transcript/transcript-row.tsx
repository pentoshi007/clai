/** @jsxImportSource @opentui/react */
/**
 * Dispatches one normalized item to its renderer (V2-051..055).
 *
 * The only place that switches on `item.kind`; adding an item kind means
 * adding one case here plus its renderer, not touching a scattered UI switch
 * (ARCHITECTURE "commands are data plus handlers, not switch statements").
 */

import { memo, type ReactNode } from "react";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { TranscriptStore } from "../../../ui-core/state/transcript-store.js";
import { type TranscriptItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { shouldHideQuietMetaToolInChat } from "../../../app/adapters/quiet-meta-tools.js";
import { UserMessage } from "./user-message.js";
import { AssistantMessage } from "./assistant-message.js";
import { ThinkingBlock } from "./thinking-block.js";
import { ToolCard } from "./tool-card.js";
import { NoticeRow } from "./notice-row.js";
import { CompactedRow } from "./compacted-row.js";

export function TranscriptRowImpl(props: {
  item: TranscriptItem;
  theme: Theme;
  store: TranscriptStore;
  spool: OutputSpool;
  services: AppServices;
  onOpenUserPrompt: (prompt: string) => void;
  /** Effective expand state for this item (per-item override or global). */
  expanded: boolean;
  /** Effective file-diff expand state (tool cards only). */
  fileDiffExpanded: boolean;
  /** Global toggle fallbacks used when a per-item override is set. */
  expandThinkingGlobal: boolean;
  expandOutputGlobal: boolean;
  expandFileDiffsGlobal: boolean;
  /** Paint reasoning while it streams (only when thinking is on). */
  liveThinking?: boolean | undefined;
  /** Chat-pane columns so markdown tables reflow beside the plan pane. */
  contentWidth?: number | undefined;
  /** This item contains at least one match for the current ^R query. */
  searchMatched?: boolean | undefined;
  /** This item is the currently selected n/N match. */
  searchActiveMatch?: boolean | undefined;
}): ReactNode {
  const {
    item,
    theme,
    store,
    spool,
    services,
    onOpenUserPrompt,
    expanded,
    fileDiffExpanded,
    expandThinkingGlobal,
    expandOutputGlobal,
    expandFileDiffsGlobal,
    liveThinking,
    contentWidth,
    searchMatched,
    searchActiveMatch,
  } = props;

  let body: ReactNode;
  switch (item.kind) {
    case "user":
      body = (
        <UserMessage
          item={item}
          theme={theme}
          onOpen={onOpenUserPrompt}
          contentWidth={contentWidth}
        />
      );
      break;
    case "assistant":
      body = (
        <AssistantMessage
          item={item}
          theme={theme}
          contentWidth={contentWidth}
        />
      );
      break;
    case "thinking":
      body = (
        <ThinkingBlock
          item={item}
          theme={theme}
          expanded={expanded}
          liveBody={liveThinking}
          contentWidth={contentWidth}
          onToggle={() => store.toggleItemOverride(item.id, expandThinkingGlobal)}
        />
      );
      break;
    case "tool": {
      // plan.create / task.update success is Tasks-pane only — hide from chat
      // so huge plan payloads never flood the transcript. Failures still show.
      if (shouldHideQuietMetaToolInChat(item.name, item.status)) {
        return null;
      }
      body = (
        <ToolCard
          item={item}
          theme={theme}
          spool={spool}
          services={services}
          expanded={expanded}
          onToggle={() => store.toggleItemOverride(item.id, expandOutputGlobal)}
          onCollapseAllOutput={() => store.setOutputGlobal(false)}
          onExpandAllOutput={() => store.setOutputGlobal(true)}
          fileDiffExpanded={fileDiffExpanded}
          onToggleFileDiff={() =>
            store.toggleFileDiffOverride(item.id, expandFileDiffsGlobal)
          }
          onCollapseAllFileDiffs={() => store.setFileDiffsGlobal(false)}
          onExpandAllFileDiffs={() => store.setFileDiffsGlobal(true)}
        />
      );
      break;
    }
    case "notice":
      body = <NoticeRow item={item} theme={theme} />;
      break;
    case "compacted":
      body = (
        <CompactedRow
          item={item}
          theme={theme}
          services={services}
          contentWidth={contentWidth}
          expanded={expanded}
          onToggle={() => {
            // Ctrl+O / toggle: open pager (do not dump multi‑KB memory in chat).
            const summary = item.summary;
            const title =
              item.beforeTokens > 0 || item.afterTokens > 0
                ? `Compacted context · ~${item.beforeTokens.toLocaleString()} → ~${item.afterTokens.toLocaleString()} tokens`
                : "Compacted context";
            services.overlay.openPager(title, summary);
          }}
        />
      );
      break;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }

  // Search highlight wrapper — active match gets a strong wash; other hits a soft one.
  if (!searchMatched) return body;
  return (
    <box
      border
      borderStyle="rounded"
      style={{
        width: "100%",
        flexDirection: "column",
        backgroundColor: searchActiveMatch ? theme.selection : theme.rowA,
        borderColor: searchActiveMatch ? theme.activity : theme.cyan,
        marginBottom: 0,
      }}
    >
      {body}
    </box>
  );
}

export const TranscriptRow = memo(TranscriptRowImpl);
