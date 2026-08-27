import type {
  KeysEditorAnswer,
  PlanConfirmResult,
} from "../../ui-core/controllers/overlay-controller.js";

export type PanelEffect =
  | { readonly kind: "close" }
  | { readonly kind: "picker-select"; readonly value: string }
  | { readonly kind: "picker-row-action"; readonly value: string }
  | { readonly kind: "confirm"; readonly ok: boolean }
  | { readonly kind: "confirm-plan"; readonly result: PlanConfirmResult }
  | { readonly kind: "view-plan" }
  | { readonly kind: "view-file" }
  | { readonly kind: "secret"; readonly value: string | undefined }
  | { readonly kind: "text-editor"; readonly value: string | undefined }
  | { readonly kind: "scope"; readonly targets: string[] | undefined }
  | { readonly kind: "keys"; readonly answer: KeysEditorAnswer | undefined }
  | { readonly kind: "copy"; readonly text: string }
  | { readonly kind: "resend" }
  | { readonly kind: "edit-prompt"; readonly text: string }
  | {
      readonly kind: "open-pager";
      readonly title: string;
      readonly body: string;
      readonly markdown?: "auto" | "force" | "plain" | undefined;
    }
  | { readonly kind: "job-tail"; readonly jobId: string }
  | { readonly kind: "job-stop"; readonly jobId: string }
  | { readonly kind: "pager-page"; readonly offset: number }
  | { readonly kind: "pager-search"; readonly query: string; readonly reverse: boolean }
  | { readonly kind: "pager-export-scrollback" }
  | { readonly kind: "pager-export-editor" }
  | { readonly kind: "search-open"; readonly itemId: string }
  | { readonly kind: "plan-hide" }
  | { readonly kind: "toast"; readonly text: string };

export interface PanelKeyResult<TState> {
  readonly state: TState;
  readonly effects: readonly PanelEffect[];
  readonly handled: boolean;
}

export function unhandled<TState>(state: TState): PanelKeyResult<TState> {
  return { state, effects: [], handled: false };
}

export function handled<TState>(
  state: TState,
  ...effects: readonly PanelEffect[]
): PanelKeyResult<TState> {
  return { state, effects, handled: true };
}
