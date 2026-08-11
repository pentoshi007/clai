import { JOBS_INITIAL_STATE } from "./jobs-panel.js";
import type { KeysPanelState } from "./keys-panel.js";
import { PAGER_INITIAL_STATE } from "./pager-panel.js";
import type { PickerPanelState } from "./picker-panel.js";
import { PROMPT_ACTIONS_INITIAL_STATE } from "./prompt-actions-panel.js";
import { PLAN_INITIAL_STATE } from "./plan-panel.js";
import type { ScopePanelState } from "./scope-panel.js";

export const EMPTY_PICKER: PickerPanelState = { query: "", cursor: 0, top: 0 };

export const EMPTY_SCOPE: ScopePanelState = {
  targets: [],
  cursor: 0,
  editing: false,
  draft: "",
  top: 0,
};

export const EMPTY_KEYS: KeysPanelState = {
  rows: [],
  cursor: 0,
  activeIndex: 0,
  editing: false,
  draft: "",
  top: 0,
};

export const EMPTY_SNAPSHOT_BASE = {
  picker: EMPTY_PICKER,
  pager: PAGER_INITIAL_STATE,
  pagerBody: "",
  pagerMarkdown: "plain" as const,
  pagerLive: false,
  jobs: JOBS_INITIAL_STATE,
  scope: EMPTY_SCOPE,
  keys: EMPTY_KEYS,
  promptActions: PROMPT_ACTIONS_INITIAL_STATE,
  plan: PLAN_INITIAL_STATE,
};
