import { Box, Text } from "ink";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Mode } from "../../types.js";
import { getConfig } from "../../store/config.js";
import { effectiveThinkingEffort } from "../../llm/capabilities.js";
import { formatComposerMeta } from "../../ui-core/composer/composer-meta.js";
import { useServices } from "../../ui-core/react/providers.js";
import { clipSegment, modeIndicatorPresentation } from "../../ui-core/rendering/status-segments.js";
import { layoutWidth } from "../render/measure.js";
import { Chrome } from "../chrome/Chrome.js";
import { Composer } from "../chrome/Composer.js";
import { directoryRow } from "../chrome/directory-row.js";
import { QueuePanel } from "../chrome/QueuePanel.js";
import { ResponderStrip } from "../chrome/ResponderStrip.js";
import { StatusBar } from "../chrome/StatusBar.js";
import { ToastRow } from "../chrome/ToastRow.js";
import { toastRowsWanted } from "../chrome/toast-rows.js";
import { composerFrame, composerTextRowsWanted } from "../chrome/composer-frame.js";
import { responderVisible } from "../chrome/responder-row.js";
import { allocateChrome, type ChromeDemand } from "../chrome/row-budget.js";
import { statusRowsWanted } from "../chrome/status-rows.js";
import { gutterShellWidth, horizontalPadding, SCROLLBAR_GUTTER_COLS } from "../render/shell-width.js";
import { LiveTail } from "../feed/LiveTail.js";
import { ScrollbarGutter } from "../feed/ScrollbarGutter.js";
import { CompletionPanel } from "../panels/CompletionPanel.js";
import { PanelHost } from "../panels/panel-host.js";
import { PlanPanel } from "../panels/PlanPanel.js";
import { completionOverlayRows } from "../panels/completion-rows.js";
import { createClassicAppWiring, overlayDemandContext, type ClassicAppWiring } from "./app-wiring.js";
import { introInputFor, useFeed } from "./use-feed.js";

const EXIT_HINT = "ctrl+c twice to exit";

export function statusRowText(input: {
  readonly mode: Mode;
  readonly model: string | undefined;
  readonly running: boolean;
  readonly columns: number;
}): string {
  return clipSegment(
    [modeIndicatorPresentation(input.mode).label, input.model ?? "no model", input.running ? "working" : EXIT_HINT].join(" · "),
    Math.max(1, input.columns - 1),
  );
}

export function ClassicApp(
  { wiring: providedWiring }: { readonly wiring?: ClassicAppWiring } = {},
): ReactNode {
  const services = useServices();
  const mcpState = useSyncExternalStore(
    services.mcp.subscribe,
    services.mcp.getState,
    services.mcp.getState,
  );
  const selectedMcpServer =
    mcpState.selection.mode === "server"
      ? mcpState.selection.serverName
      : undefined;
  const wiring = useMemo(
    () => providedWiring ?? createClassicAppWiring({ services, mouse: services.capabilities.mouse }),
    [providedWiring, services],
  );
  useEffect(() => {
    if (providedWiring) return;
    return () => wiring.dispose();
  }, [providedWiring, wiring]);
  const snapshot = useSyncExternalStore(wiring.subscribe, wiring.getSnapshot, wiring.getSnapshot);
  const { session, composer, panel, plan, columns, rows } = snapshot;
  const shellPadding = horizontalPadding(columns);
  const shellWidth = gutterShellWidth(columns);
  const completionOpen = panel.kind === "none" && composer.menu.kind !== "none";
  const panelContext = overlayDemandContext(panel);
  const overlay = panelContext
    ? { kind: panelContext, rowsWanted: wiring.panels.rowsWanted() }
    : completionOpen
      ? { kind: "picker" as const, rowsWanted: completionOverlayRows(rows) }
      : undefined;
  const demand: ChromeDemand = {
    rows,
    columns: shellWidth,
    composerTextRows: composerTextRowsWanted({ columns: shellWidth, text: composer.state.text }),
    statusRowsWanted: statusRowsWanted(),
    toastCount: toastRowsWanted(snapshot.toasts, shellWidth),
    queueCount: session.queued.length,
    responderVisible: responderVisible(session.responder),
    planVisible: snapshot.planVisible && plan !== undefined,
    planRowsWanted: plan?.tasks.length ?? 0,
    overlay,
  };
  const layout = allocateChrome(demand);
  const intro = useMemo(
    () => introInputFor(services),
    [services, snapshot.feedGeneration, session.mode, session.provider, session.model],
  );
  const feed = useFeed({
    services,
    state: snapshot.transcript,
    columns: shellWidth,
    liveBudgetRows: layout.liveTail,
    now: snapshot.feedNow,
    generation: snapshot.feedGeneration,
    liveOffset: snapshot.liveOffset,
    intro,
  });
  const selectionDocument = useMemo(
    () => wiring.transcriptSelectionDocument(feed.blocks),
    [wiring, feed.blocks],
  );
  const selection = services.selection.getState();
  const standaloneLabel = providedWiring === undefined ? "clai classic · Ctrl+C twice to exit" : undefined;
  const phase = wiring.contextLimitEditingValue ? "suspended" : session.running ? "running" : "idle";
  // Same meta the opentui composer shows on its border: provider · model ·
  // permission, preferring the live session selection over config defaults.
  const cfg = getConfig();
  const metaLabel = formatComposerMeta(
    session.provider ?? cfg.defaultProvider,
    session.model ?? cfg.defaultModel,
    cfg.permissions ?? "default",
    effectiveThinkingEffort(
      session.provider ?? cfg.defaultProvider,
      session.model ?? cfg.defaultModel,
      cfg.thinking,
    ),
  );
  const frame = composerFrame({ columns: shellWidth, allocatedRows: layout.composer, text: composer.state.text, mode: session.mode, phase, unicode: feed.ink.unicode, metaLabel });
  const blinkOn = Math.floor(snapshot.animationTick / 2) % 2 === 0;
  const frameWithBlink = { ...frame, showCaret: frame.showCaret && blinkOn };

  useEffect(() => wiring.observeFeed(feed, selectionDocument), [wiring, feed, selectionDocument]);
  useEffect(
    () => wiring.setTranscriptSelectionGeometry({
      left: shellPadding,
      top: (standaloneLabel === undefined ? 0 : 1) + layout.toast,
    }),
    [wiring, shellPadding, standaloneLabel, layout.toast],
  );
  useEffect(() => wiring.setComposerTextWidth(frame.textWidth), [wiring, frame.textWidth]);

  const panelSlot = panelContext ? (
    <PanelHost controller={wiring.panels} ink={feed.ink} columns={shellWidth} rows={layout.overlay} jobs={snapshot.jobs} transcript={snapshot.transcript} now={snapshot.now} />
  ) : completionOpen ? (
    <CompletionPanel ink={feed.ink} menu={composer.menu} active={composer.active} columns={shellWidth} rows={layout.overlay} />
  ) : undefined;

  return <Box flexDirection="row" width={columns}>
    <Box width={columns - SCROLLBAR_GUTTER_COLS} paddingLeft={shellPadding} paddingRight={Math.max(0, shellPadding - SCROLLBAR_GUTTER_COLS)} flexDirection="column">
      {standaloneLabel === undefined ? null : <Text wrap="truncate">{standaloneLabel}</Text>}
      <Chrome layout={layout} columns={shellWidth} liveTail={<LiveTail window={feed.window} rows={layout.liveTail} document={selectionDocument} selection={selection} />} slots={{
      plan: plan && snapshot.planVisible ? <PlanPanel ink={feed.ink} columns={shellWidth} rows={layout.plan} plan={plan} state={panel.plan} focused={services.focus.activeContext() === "plan"} /> : undefined,
      overlay: panelSlot,
      queue: <QueuePanel ink={feed.ink} columns={shellWidth} allocatedRows={layout.queue} queued={session.queued} selected={snapshot.queueSelected} />,
      responder: <ResponderStrip ink={feed.ink} columns={shellWidth} state={session.responder} />,
      toast: <ToastRow ink={feed.ink} columns={shellWidth} allocatedRows={layout.toast} toasts={snapshot.toasts} />,
      composer: <Box flexDirection="column" flexShrink={0} width={shellWidth}>
        {frame.showDirectory ? <Text wrap="truncate"> </Text> : null}
        {frame.showDirectory ? (
          <Text wrap="truncate">
            {(() => {
              const dir = directoryRow({ ink: feed.ink, columns: shellWidth, cwd: snapshot.cwd, branch: snapshot.branch });
              const hasActivePlan = plan !== undefined;
              const isExpanded = snapshot.planVisible;
              if (!hasActivePlan || isExpanded) return dir;
              const hint = feed.ink.fg("inputBorder", "Tasks active . cntrl+H to expand");
              const width = Math.max(1, shellWidth - 2);
              const left = dir.trim();
              const gap = "   ";
              if (layoutWidth(left) + layoutWidth(gap) + layoutWidth(hint) <= width) {
                return ` ${left}${gap}${hint} `;
              }
              return ` ${clipSegment(hint, width)} `;
            })()}
          </Text>
        ) : null}
        <Composer ink={feed.ink} frame={frameWithBlink} state={composer.state} accentSpans={composer.skillSpans} selectedMcpServer={selectedMcpServer} />
      </Box>,
      status: <StatusBar ink={feed.ink} columns={shellWidth} allocatedRows={layout.status} mode={session.mode} contextChip={session.contextChip} contextUsage={session.contextUsage} contextLimitEditing={wiring.contextLimitEditingValue} contextLimitDraft={wiring.contextLimitDraftValue} running={session.running} compacting={session.compacting} activity={snapshot.transcript.runningStatus} cancelArmed={snapshot.cancelArmed} tick={snapshot.tick + snapshot.animationTick} hasDraft={composer.state.text.length > 0} queued={session.queued.length} planVisible={snapshot.planVisible} hasActivePlan={plan !== undefined} thinkingExpanded={snapshot.transcript.expandThinkingGlobal} outputExpanded={snapshot.transcript.expandOutputGlobal} />,
    }} />
    </Box>
    <ScrollbarGutter ink={feed.ink} window={feed.window} rows={layout.liveTail} offsetTop={(standaloneLabel === undefined ? 0 : 1) + layout.toast} />
  </Box>;
}
