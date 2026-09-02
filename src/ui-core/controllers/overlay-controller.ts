
import type { FocusController, OverlayContext } from "./focus-controller.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import type { ArtifactPagerSource } from "../rendering/artifact-pager-source.js";

export type ConfirmKind = "tool" | "pentest" | "reset" | "continue" | "plan" | "switch";

export type PlanConfirmResult = "implement" | "discard" | "suggest" | "dismiss";

export interface ConfirmRequest {
  readonly kind: ConfirmKind;
  readonly prompt: string;
  readonly viewPath?: string | undefined;
}

export interface PickerRowAction {
  readonly chord: string;
  readonly hint: string;
}

export interface PickerRequest {
  readonly title: string;
  readonly options: readonly PickerOption[];
  readonly rowAction?: PickerRowAction | undefined;
  readonly searchDescription?: boolean | undefined;
  readonly twoLine?: boolean | undefined;
  readonly historyStyle?: boolean | undefined;
}

export interface SecretRequestView {
  readonly title: string;
  readonly prompt: string;
  readonly reveal?: boolean | undefined;
  readonly initialValue?: string | undefined;
}

export interface ScopeEditorRequest {
  readonly initialTargets: readonly string[];
}

export interface TextEditorRequest {
  readonly title: string;
  readonly prompt: string;
  readonly initialValue?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly submitLabel?: string | undefined;
}

export interface KeysEditorSlotView {
  readonly id: string;
  readonly masked: string;
  readonly disabled?: boolean | undefined;
}

export interface KeysEditorRequest {
  readonly provider: string;
  readonly initialKeys: readonly KeysEditorSlotView[];
  readonly activeIndex?: number | undefined;
  readonly itemLabel?: string | undefined;
  readonly heading?: string | undefined;
}

/**
 * Save rows: empty `value` + `slotId` keeps the stored secret; non-empty value
 * is a new/replacement plaintext key. Reset clears all keys for the provider.
 */
export type KeysEditorAnswer =
  | { readonly action: "save"; readonly rows: readonly { slotId?: string; value: string; disabled?: boolean }[]; readonly activeIndex?: number | undefined }
  | { readonly action: "reset" };

export interface PromptActionsRequest {
  readonly prompt: string;
  readonly onResend: () => void;
}

export type OverlayState =
  | { readonly kind: "none" }
  | {
      readonly kind: "picker";
      readonly request: PickerRequest;
      readonly onSelect: (value: string) => void;
      readonly onRowAction?: ((value: string) => void) | undefined;
    }
  | {
      readonly kind: "confirm";
      readonly request: ConfirmRequest;
      readonly resolve: (ok: boolean | PlanConfirmResult) => void;
      readonly onViewPlan?: (() => void) | undefined;
      readonly onViewFile?: (() => void) | undefined;
      readonly planResolve?: ((result: PlanConfirmResult) => void) | undefined;
    }
  | { readonly kind: "secret"; readonly request: SecretRequestView; readonly resolve: (value: string | undefined) => void }
  | {
      readonly kind: "text-editor";
      readonly request: TextEditorRequest;
      readonly resolve: (value: string | undefined) => void;
    }
  | {
      readonly kind: "scope-editor";
      readonly request: ScopeEditorRequest;
      readonly resolve: (targets: string[] | undefined) => void;
    }
  | {
      readonly kind: "keys-editor";
      readonly request: KeysEditorRequest;
      readonly resolve: (answer: KeysEditorAnswer | undefined) => void;
    }
  | { readonly kind: "prompt-actions"; readonly request: PromptActionsRequest }
  | {
      readonly kind: "pager";
      readonly title: string;
      readonly body: string;
      readonly source?: ArtifactPagerSource | undefined;
      readonly highlightPath?: string | undefined;
      readonly markdown?: "auto" | "force" | "plain" | undefined;
    }
  | { readonly kind: "jobs" };

export type OverlayListener = () => void;

const NONE: OverlayState = { kind: "none" };

export class OverlayController {
  private state: OverlayState = NONE;
  private suspended: OverlayState | undefined;
  private readonly listeners = new Set<OverlayListener>();
  private closeFocus: (() => void) | undefined;

  constructor(private readonly focus: FocusController) {}

  getState(): OverlayState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state.kind !== "none";
  }

  subscribe(listener: OverlayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  openPicker(
    request: PickerRequest,
    onSelect: (value: string) => void,
    onRowAction?: (value: string) => void,
  ): boolean {
    return this.open(
      {
        kind: "picker",
        request,
        onSelect,
        ...(onRowAction ? { onRowAction } : {}),
      },
      "picker",
    );
  }

  replacePickerOptions(options: readonly PickerOption[], title?: string): void {
    if (this.state.kind !== "picker") return;
    this.state = {
      ...this.state,
      request: {
        ...this.state.request,
        options,
        ...(title !== undefined ? { title } : {}),
      },
    };
    this.notify();
  }

  openPager(
    title: string,
    body: string,
    source?: ArtifactPagerSource,
    highlightPath?: string,
    markdown?: "auto" | "force" | "plain",
  ): boolean {
    const pager = {
      kind: "pager" as const,
      title,
      body,
      ...(source ? { source } : {}),
      ...(highlightPath ? { highlightPath } : {}),
      ...(markdown ? { markdown } : {}),
    };
    const stackable = this.state.kind === "confirm" || this.state.kind === "jobs";
    const opened =
      stackable && !this.suspended
        ? this.suspendUnder(pager, "pager")
        : this.open(pager, "pager");
    if (!opened) source?.dispose();
    return opened;
  }

  openJobs(): boolean {
    return this.open({ kind: "jobs" }, "jobs");
  }

  openPromptActions(request: PromptActionsRequest): boolean {
    return this.open({ kind: "prompt-actions", request }, "modal");
  }

  openConfirm(
    request: ConfirmRequest,
    onViewPlan?: () => void,
    onViewFile?: () => void,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const opened = this.open(
        {
          kind: "confirm",
          request,
          resolve: (ok) => resolve(ok === true || ok === "implement"),
          ...(onViewPlan ? { onViewPlan } : {}),
          ...(onViewFile ? { onViewFile } : {}),
        },
        "modal",
      );
      if (!opened) resolve(false);
    });
  }

  openPlanConfirm(
    request: ConfirmRequest,
    onViewPlan?: () => void,
  ): Promise<PlanConfirmResult> {
    return new Promise((resolve) => {
      const planResolve = (result: PlanConfirmResult): void => resolve(result);
      const opened = this.open(
        {
          kind: "confirm",
          request: { ...request, kind: "plan" },
          resolve: (ok) => {
            if (ok === true) resolve("implement");
            else if (ok === false) resolve("discard");
            else resolve(ok);
          },
          onViewPlan,
          planResolve,
        },
        "modal",
      );
      if (!opened) resolve("dismiss");
    });
  }

  openSecret(request: SecretRequestView): Promise<string | undefined> {
    return new Promise((resolve) => {
      const opened = this.open({ kind: "secret", request, resolve }, "secret");
      if (!opened) resolve(undefined);
    });
  }

  openTextEditor(request: TextEditorRequest): Promise<string | undefined> {
    return new Promise((resolve) => {
      const opened = this.open({ kind: "text-editor", request, resolve }, "modal");
      if (!opened) resolve(undefined);
    });
  }

  answerTextEditor(value: string | undefined): void {
    if (this.state.kind !== "text-editor") return;
    const { resolve } = this.state;
    this.state = { kind: "text-editor", request: this.state.request, resolve: () => undefined };
    this.forceClose();
    resolve(value);
  }

  openScopeEditor(request: ScopeEditorRequest): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      const opened = this.open(
        { kind: "scope-editor", request, resolve },
        "modal",
      );
      if (!opened) resolve(undefined);
    });
  }

  answerScope(targets: string[] | undefined): void {
    if (this.state.kind !== "scope-editor") return;
    const { resolve } = this.state;
    this.forceClose();
    resolve(targets);
  }

  openKeysEditor(request: KeysEditorRequest): Promise<KeysEditorAnswer | undefined> {
    return new Promise((resolve) => {
      const opened = this.open(
        { kind: "keys-editor", request, resolve },
        "modal",
      );
      if (!opened) resolve(undefined);
    });
  }

  answerKeys(answer: KeysEditorAnswer | undefined): void {
    if (this.state.kind !== "keys-editor") return;
    const { resolve } = this.state;
    this.forceClose();
    resolve(answer);
  }

  answerConfirm(ok: boolean): void {
    const confirm = this.activeConfirm();
    if (!confirm) return;
    if (confirm.request.kind === "plan" && confirm.planResolve) {
      this.answerPlanConfirm(ok ? "implement" : "discard");
      return;
    }
    const { resolve } = confirm;
    this.suspended = undefined;
    this.forceClose();
    resolve(ok);
  }

  answerPlanConfirm(result: PlanConfirmResult): void {
    const confirm = this.activeConfirm();
    if (!confirm || confirm.request.kind !== "plan") return;
    const planResolve = confirm.planResolve;
    const { resolve } = confirm;
    this.suspended = undefined;
    this.forceClose();
    if (planResolve) planResolve(result);
    else resolve(result === "implement");
  }

  answerSecret(value: string | undefined): void {
    if (this.state.kind !== "secret") return;
    const { resolve } = this.state;
    this.forceClose();
    resolve(value);
  }

  cancelBlockingPrompt(): boolean {
    if (this.state.kind === "secret") {
      this.answerSecret(undefined);
      return true;
    }
    if (this.state.kind === "confirm") {
      if (this.state.request.kind === "plan" && this.state.planResolve) {
        this.answerPlanConfirm("dismiss");
      } else {
        this.answerConfirm(false);
      }
      return true;
    }
    if (this.state.kind === "scope-editor") {
      this.answerScope(undefined);
      return true;
    }
    if (this.state.kind === "keys-editor") {
      this.answerKeys(undefined);
      return true;
    }
    if (this.state.kind === "text-editor") {
      this.answerTextEditor(undefined);
      return true;
    }
    return false;
  }

  selectPicker(value: string): void {
    if (this.state.kind !== "picker") return;
    this.state.onSelect(value);
  }

  actOnPickerRow(value: string): void {
    if (this.state.kind !== "picker") return;
    this.state.onRowAction?.(value);
  }

  close(): void {
    if (this.state.kind === "none") return;
    if (this.suspended) {
      this.restoreSuspended();
      return;
    }
    this.forceClose();
  }

  dispose(): void {
    if (this.suspended?.kind === "confirm") {
      if (this.suspended.request.kind === "plan" && this.suspended.planResolve) {
        this.suspended.planResolve("dismiss");
      } else {
        this.suspended.resolve(false);
      }
    } else if (this.state.kind === "confirm") {
      if (this.state.request.kind === "plan" && this.state.planResolve) {
        this.state.planResolve("dismiss");
      } else {
        this.state.resolve(false);
      }
    } else if (this.state.kind === "secret") this.state.resolve(undefined);
    else if (this.state.kind === "text-editor") this.state.resolve(undefined);
    else if (this.state.kind === "scope-editor") this.state.resolve(undefined);
    else if (this.state.kind === "keys-editor") this.state.resolve(undefined);
    this.suspended = undefined;
    this.forceClose();
    this.listeners.clear();
  }

  private activeConfirm(): Extract<OverlayState, { kind: "confirm" }> | undefined {
    if (this.state.kind === "confirm") return this.state;
    if (this.suspended?.kind === "confirm") return this.suspended;
    return undefined;
  }

  private open(next: OverlayState, context: OverlayContext): boolean {
    if (this.state.kind !== "none" || this.suspended) return false;
    try {
      this.closeFocus = this.focus.pushOverlay(context);
    } catch {
      return false;
    }
    this.state = next;
    this.notify();
    return true;
  }

  private suspendUnder(next: OverlayState, context: OverlayContext): boolean {
    this.suspended = this.state;
    this.closeFocus?.();
    try {
      this.closeFocus = this.focus.pushOverlay(context);
    } catch {
      this.suspended = undefined;
      try {
        this.closeFocus = this.focus.pushOverlay("modal");
      } catch {
        this.closeFocus = undefined;
      }
      return false;
    }
    this.state = next;
    this.notify();
    return true;
  }

  private restoreSuspended(): void {
    if (this.state.kind === "pager") this.state.source?.dispose();
    const previous = this.suspended;
    this.suspended = undefined;
    this.closeFocus?.();
    this.closeFocus = undefined;
    if (!previous || previous.kind === "none") {
      this.state = NONE;
      this.notify();
      return;
    }
    const context: OverlayContext =
      previous.kind === "confirm"
        ? "modal"
        : previous.kind === "secret"
          ? "secret"
          : previous.kind === "picker"
            ? "picker"
            : previous.kind === "jobs"
              ? "jobs"
              : previous.kind === "prompt-actions"
                ? "modal"
              : "pager";
    try {
      this.closeFocus = this.focus.pushOverlay(context);
      this.state = previous;
    } catch {
      this.state = NONE;
      if (previous.kind === "confirm") {
        if (previous.request.kind === "plan" && previous.planResolve) {
          previous.planResolve("dismiss");
        } else {
          previous.resolve(false);
        }
      } else if (previous.kind === "secret") previous.resolve(undefined);
      else if (previous.kind === "text-editor") previous.resolve(undefined);
    }
    this.notify();
  }

  private forceClose(): void {
    if (this.state.kind === "pager") this.state.source?.dispose();
    const pending = this.state.kind === "text-editor" ? this.state.resolve : undefined;
    this.state = NONE;
    this.closeFocus?.();
    this.closeFocus = undefined;
    pending?.(undefined);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
