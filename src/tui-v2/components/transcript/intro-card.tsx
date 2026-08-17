/** @jsxImportSource @opentui/react */
/**
 * Startup intro / model card for OpenTUI v2.
 *
 * Same layout and colors as the legacy Ink TUI: chalk lines from
 * `renderIntroHeaderLines` converted to OpenTUI `StyledText` so chips,
 * badges, and the wordmark gradient keep their colors (not B&W).
 * Always the first scroll child so it scrolls with chat.
 */

import { useMemo, type ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { homedir } from "node:os";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { ansiToStyledText } from "../../rendering/ansi-to-styled.js";
import { renderIntroHeaderLines } from "../../../ui-core/rendering/intro-header.js";
import { getCurrentVersion } from "../../../commands/update.js";
import { getConfig } from "../../../store/config.js";
import { effectiveThinkingEffort } from "../../../llm/capabilities.js";
import { safeCwd } from "../../../os/cwd.js";

export interface IntroCardProps {
  readonly services: AppServices;
  readonly theme: Theme;
  /** Available width of the chat pane (fallback: full terminal width). */
  readonly width?: number | undefined;
}

function displayWorkdir(workdir: string): string {
  const home = homedir();
  return workdir.startsWith(home) ? `~${workdir.slice(home.length)}` : workdir;
}

export function IntroCard(props: IntroCardProps): ReactNode {
  const { services, width: widthProp } = props;
  const { width: termWidth } = useTerminalDimensions();
  const width = widthProp ?? Math.max(56, termWidth - 4);

  const session = services.session.getState();
  const cfg = getConfig();
  const permissions = cfg.permissions ?? "default";
  const version = getCurrentVersion();
  const workdir = displayWorkdir(safeCwd());

  // Fall back to the configured defaults (never the literal "default") so the
  // card always shows the real provider and its exact model, matching the
  // composer meta line, even before the session selection is populated.
  const provider = session.provider ?? cfg.defaultProvider;
  const model = session.model ?? cfg.defaultModel;
  const variant = effectiveThinkingEffort(provider, model, cfg.thinking) ?? "off";

  const lines = useMemo(
    () =>
      renderIntroHeaderLines({
        width,
        version,
        mode: session.mode,
        provider,
        model,
        permissions,
        workdir,
        variant,
      }).map((line) => ansiToStyledText(line.length === 0 ? " " : line)),
    [
      width,
      version,
      session.mode,
      provider,
      model,
      permissions,
      workdir,
      variant,
    ],
  );

  return (
    <box
      id="intro-card"
      style={{ flexDirection: "column", width: "100%", marginBottom: 1 }}
    >
      {lines.map((content, i) => (
        <text key={i} content={content} selectable={false} />
      ))}
    </box>
  );
}
