/** @jsxImportSource @opentui/react */
/**
 * Responsive v2 shell (V2-032).
 *
 * An intentionally empty shell for Phase 3: it lays out the persistent regions
 * (status, chat, optional plan, composer, overlay portal) and proves the
 * renderer starts/stops cleanly. Region geometry follows the pure
 * `computeLayout` engine so the visible frame matches the Node-tested snapshots.
 * Real content arrives in later phases.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { computeLayout } from "../layout/compute-layout.js";
import { ComposerEditor } from "../composer/composer-editor.js";
import { useServices, useTheme } from "./providers.js";

export function App(): ReactNode {
  const { width, height } = useTerminalDimensions();
  const services = useServices();
  const theme = useTheme();
  const [focusContext, setFocusContext] = useState(services.focus.activeContext());
  useEffect(() => services.focus.onChange(setFocusContext), [services.focus]);
  const layout = computeLayout({
    columns: width,
    rows: height,
    planVisible: false,
    splitEnabled: layoutSupportsSplit(width),
  });

  const state = services.session.getState();
  const providerLabel = state.provider ?? "default";
  const statusText = layout.statusCondensed
    ? `clai · ${state.mode}`
    : `clai · ${state.mode} · ${providerLabel}${
        state.model ? ` · ${state.model}` : ""
      }`;

  return (
    <box
      style={{
        width,
        height,
        flexDirection: "column",
        backgroundColor: theme.background,
      }}
    >
      <box
        style={{
          height: 1,
          width: "100%",
          backgroundColor: theme.statusBackground,
          paddingLeft: 1,
        }}
      >
        <text style={{ fg: theme.foreground }}>{statusText}</text>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", width: "100%" }}>
        <box
          title="Chat"
          border={layout.showOptionalChrome}
          style={{ flexGrow: 1, borderColor: theme.border }}
        >
          <text style={{ fg: theme.muted }}>
            No messages yet. Type below to start.
          </text>
        </box>
        {layout.plan.placement === "split" ? (
          <box
            title="Plan"
            border
            style={{ width: layout.plan.width, borderColor: theme.border }}
          >
            <text style={{ fg: theme.muted }}>No plan.</text>
          </box>
        ) : null}
      </box>

      <box
        title="Composer"
        border={layout.showOptionalChrome}
        style={{
          height: layout.composer.height + (layout.showOptionalChrome ? 2 : 0),
          width: "100%",
          borderColor: theme.border,
        }}
      >
        <ComposerEditor
          services={services}
          theme={theme}
          width={layout.composer.width}
          height={layout.composer.height}
          focused={focusContext === "composer"}
        />
      </box>
    </box>
  );
}

/** Split view is only worthwhile once the terminal is wide (ARCHITECTURE). */
function layoutSupportsSplit(columns: number): boolean {
  return columns >= 120;
}
