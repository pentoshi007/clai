import { useSyncExternalStore, type ReactNode } from "react";
import type { BackgroundJob } from "../../app/ports/jobs-port.js";
import type { InkTheme } from "../render/ink-theme.js";
import { ConfirmPanel } from "./ConfirmPanel.js";
import { JobsPanel } from "./JobsPanel.js";
import { KeysPanel } from "./KeysPanel.js";
import { PagerPanel } from "./PagerPanel.js";
import { pagerViewModel } from "./pager-panel.js";
import type { PanelController, PanelSnapshot } from "./panel-controller.js";
import { PickerPanel } from "./PickerPanel.js";
import { PromptActionsPanel } from "./PromptActionsPanel.js";
import { ScopePanel } from "./ScopePanel.js";
import { SearchPanel } from "./SearchPanel.js";
import { SecretPanel } from "./SecretPanel.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";

export interface PanelHostProps {
  readonly controller: PanelController;
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly jobs: readonly BackgroundJob[];
  readonly transcript: TranscriptState;
  readonly now: number;
}

export function usePanelSnapshot(controller: PanelController): PanelSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function PanelHost(props: PanelHostProps): ReactNode {
  const snapshot = usePanelSnapshot(props.controller);
  const shared = { ink: props.ink, columns: props.columns, rows: props.rows };
  if (props.rows <= 0) return null;
  const overlay = snapshot.overlay;

  switch (overlay.kind) {
    case "picker":
      return <PickerPanel {...shared} request={overlay.request} state={snapshot.picker} />;
    case "pager": {
      const view = pagerViewModel(
        snapshot.pagerBody,
        props.columns,
        props.rows,
        snapshot.pager.format,
      );
      return (
        <PagerPanel
          {...shared}
          title={overlay.title}
          lines={view.lines}
          searchLines={view.searchLines}
          state={snapshot.pager}
          live={snapshot.pagerLive}
        />
      );
    }
    case "jobs":
      return (
        <JobsPanel {...shared} jobs={props.jobs} state={snapshot.jobs} now={props.now} />
      );
    case "confirm":
      return <ConfirmPanel {...shared} request={overlay.request} />;
    case "secret":
      return <SecretPanel {...shared} request={overlay.request} state={snapshot.secret} />;
    case "scope-editor":
      return <ScopePanel {...shared} state={snapshot.scope} />;
    case "keys-editor":
      return <KeysPanel {...shared} request={overlay.request} state={snapshot.keys} />;
    case "prompt-actions":
      return (
        <PromptActionsPanel
          {...shared}
          request={overlay.request}
          state={snapshot.promptActions}
        />
      );
    default:
      break;
  }

  if (snapshot.search !== undefined) {
    return <SearchPanel {...shared} transcript={props.transcript} state={snapshot.search} />;
  }
  return null;
}
