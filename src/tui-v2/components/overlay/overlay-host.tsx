/** @jsxImportSource @opentui/react */

import { memo } from "react";
import type { ReactNode } from "react";
import { countRender } from "../../perf/render-counters.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { useOverlayState } from "../../../ui-core/react/use-overlay.js";
import { Picker } from "../picker/picker.js";
import { ConfirmModal } from "../modal/confirm-modal.js";
import { PromptActionsModal } from "../modal/prompt-actions-modal.js";
import { SecretModal } from "../modal/secret-modal.js";
import { ScopeModal } from "../modal/scope-modal.js";
import { KeysModal } from "../modal/keys-modal.js";
import { TextEditorModal } from "../modal/text-editor-modal.js";
import { Pager } from "../pager/pager.js";
import { JobsPanel } from "../jobs/jobs-panel.js";

export interface OverlayHostProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly docked?: boolean | undefined;
}

function isDockedKind(kind: string): boolean {
  return (
    kind === "confirm" ||
    kind === "secret" ||
    kind === "scope-editor" ||
    kind === "keys-editor"
  );
}

function OverlayHostImpl(props: OverlayHostProps): ReactNode {
  countRender("OverlayHost");
  const { services, theme, width, height, docked } = props;
  const state = useOverlayState(services.overlay);
  if (state.kind === "none") return null;

  if (docked) {
    if (!isDockedKind(state.kind)) return null;
    return (
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          flexShrink: 0,
          marginBottom: 1,
        }}
      >
        {state.kind === "confirm" ? (
          <ConfirmModal
            services={services}
            theme={theme}
            request={state.request}
            onViewPlan={state.onViewPlan}
            onViewFile={state.onViewFile}
            docked
          />
        ) : null}
        {state.kind === "secret" ? (
          <SecretModal
            services={services}
            theme={theme}
            request={state.request}
            docked
          />
        ) : null}
        {state.kind === "scope-editor" ? (
          <ScopeModal
            services={services}
            theme={theme}
            request={state.request}
            docked
          />
        ) : null}
        {state.kind === "keys-editor" ? (
          <KeysModal
            services={services}
            theme={theme}
            request={state.request}
            docked
          />
        ) : null}
      </box>
    );
  }

  if (isDockedKind(state.kind)) return null;

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        zIndex: 100,
        backgroundColor: theme.background,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {state.kind === "picker" ? (
        <Picker services={services} theme={theme} request={state.request} />
      ) : null}
      {state.kind === "prompt-actions" ? (
        <PromptActionsModal services={services} theme={theme} request={state.request} />
      ) : null}
      {state.kind === "pager" ? (
        <Pager
          services={services}
          theme={theme}
          title={state.title}
          body={state.body}
          source={state.source}
          highlightPath={state.highlightPath}
          markdown={state.markdown}
        />
      ) : null}
      {state.kind === "jobs" ? <JobsPanel services={services} theme={theme} /> : null}
      {state.kind === "text-editor" ? (
        <TextEditorModal
          services={services}
          theme={theme}
          request={state.request}
          width={width}
          height={height}
        />
      ) : null}
    </box>
  );
}
export const OverlayHost = memo(OverlayHostImpl);