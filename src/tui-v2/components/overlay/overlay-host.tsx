/** @jsxImportSource @opentui/react */
/**
 * Dispatches the one active OverlayController request to its component
 * (V2-071..076). Full-screen absolute host with a solid backdrop so chat
 * content cannot bleed through pickers/modals, and so open/close never
 * reflows the intro card or status chrome underneath.
 */

import type { ReactNode } from "react";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { useOverlayState } from "../../state/use-overlay.js";
import { Picker } from "../picker/picker.js";
import { ConfirmModal } from "../modal/confirm-modal.js";
import { PromptActionsModal } from "../modal/prompt-actions-modal.js";
import { SecretModal } from "../modal/secret-modal.js";
import { Pager } from "../pager/pager.js";
import { JobsPanel } from "../jobs/jobs-panel.js";

export interface OverlayHostProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
}

export function OverlayHost(props: OverlayHostProps): ReactNode {
  const { services, theme, width, height } = props;
  const state = useOverlayState(services.overlay);
  if (state.kind === "none") return null;

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height,
        zIndex: 100,
        // Full-bleed fill so the padded shell underneath never shows through
        // edges (which used to look like a "broken" CLAI card under Ctrl+P).
        backgroundColor: theme.background,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {state.kind === "picker" ? (
        <Picker services={services} theme={theme} request={state.request} />
      ) : null}
      {state.kind === "confirm" ? (
        <ConfirmModal
          services={services}
          theme={theme}
          request={state.request}
          onViewPlan={state.onViewPlan}
        />
      ) : null}
      {state.kind === "secret" ? (
        <SecretModal services={services} theme={theme} request={state.request} />
      ) : null}
      {state.kind === "prompt-actions" ? (
        <PromptActionsModal services={services} theme={theme} request={state.request} />
      ) : null}
      {state.kind === "pager" ? (
        <Pager services={services} theme={theme} title={state.title} body={state.body} />
      ) : null}
      {state.kind === "jobs" ? <JobsPanel services={services} theme={theme} /> : null}
    </box>
  );
}
