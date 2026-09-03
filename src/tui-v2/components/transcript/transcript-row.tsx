/** @jsxImportSource @opentui/react */

import { memo, type ReactNode } from "react";
import { countRender } from "../../perf/render-counters.js";
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
import { turnSummaryLabel } from "../../../ui-core/rendering/duration.js";

export function TranscriptRowImpl(props: {
  item: TranscriptItem;
  theme: Theme;
  store: TranscriptStore;
  spool: OutputSpool;
  services: AppServices;
  onOpenUserPrompt: (prompt: string) => void;
  expanded: boolean;
  fileDiffExpanded: boolean;
  expandThinkingGlobal: boolean;
  expandOutputGlobal: boolean;
  expandFileDiffsGlobal: boolean;
  contentWidth?: number | undefined;
  searchMatched?: boolean | undefined;
  searchActiveMatch?: boolean | undefined;
  thinkingFocused?: boolean | undefined;
}): ReactNode {
  countRender("TranscriptRow");
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
    contentWidth,
    searchMatched,
    searchActiveMatch,
    thinkingFocused,
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
          colorMode={services.capabilities.colorMode}
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
          contentWidth={contentWidth}
          focused={thinkingFocused ?? false}
          onFocus={() => {
            services.focus.focusRegion("transcript");
            store.focusThinking(item.id);
          }}
          onBlur={() => store.blurThinking()}
          onToggle={() => store.toggleThinkingItem(item.id, expandThinkingGlobal)}
        />
      );
      break;
    case "tool": {
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
      body = <NoticeRow item={item} theme={theme} contentWidth={contentWidth} />;
      break;
    case "turn-summary":
      body = (
        <text selectable style={{ fg: theme.muted }}>
          {`✻ ${turnSummaryLabel(item.durationMs, item.status)}`}
        </text>
      );
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
