import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import type { JobsPort } from "../../app/ports/jobs-port.js";
import type { SessionPlan } from "../../store/plan.js";
import type {
  OverlayController,
  OverlayState,
} from "../../ui-core/controllers/overlay-controller.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";
import type { JobsPanelState } from "./jobs-panel.js";
import type { KeysPanelState } from "./keys-panel.js";
import type { PagerMarkdownMode, PagerPanelState } from "./pager-panel.js";
import type { PickerPanelState } from "./picker-panel.js";
import type { PlanPanelState } from "./plan-panel.js";
import type { PromptActionsPanelState } from "./prompt-actions-panel.js";
import type { ScopePanelState } from "./scope-panel.js";
import type { SearchPanelState } from "./search-panel.js";
import type { SecretPanelState } from "./secret-panel.js";

export type PanelKind = OverlayState["kind"] | "search";

export interface PanelSnapshot {
  readonly overlay: OverlayState;
  readonly kind: PanelKind;
  readonly picker: PickerPanelState;
  readonly pager: PagerPanelState;
  readonly pagerBody: string;
  readonly pagerMarkdown: PagerMarkdownMode;
  readonly pagerLive: boolean;
  readonly jobs: JobsPanelState;
  readonly secret: SecretPanelState;
  readonly scope: ScopePanelState;
  readonly keys: KeysPanelState;
  readonly promptActions: PromptActionsPanelState;
  readonly search: SearchPanelState | undefined;
  readonly plan: PlanPanelState;
}

export interface PanelControllerDeps {
  readonly overlay: OverlayController;
  readonly clipboard: ClipboardPort;
  readonly jobs?: JobsPort | undefined;
  readonly transcript: () => TranscriptState;
  readonly plan: () => SessionPlan | undefined;
  readonly columns: () => number;
  readonly rows: () => number;
  readonly onToast: (text: string) => void;
  readonly onEditPrompt: (text: string) => void;
  readonly onHidePlan: () => void;
  readonly onRevealItem: (itemId: string) => void;
  readonly exportScrollback?: ((body: string) => void) | undefined;
  readonly exportEditor?: ((body: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}
