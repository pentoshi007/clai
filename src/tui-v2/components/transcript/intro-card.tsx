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
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { ansiToStyledText } from "../../rendering/ansi-to-styled.js";
import { renderIntroHeaderLines } from "../../../ui/intro-header.js";
import { getCurrentVersion } from "../../../commands/update.js";
import { getConfig } from "../../../store/config.js";
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
  const permissions = getConfig().permissions ?? "default";
  const version = getCurrentVersion();
  const workdir = displayWorkdir(safeCwd());

  const lines = useMemo(
    () =>
      renderIntroHeaderLines({
        width,
        version,
        mode: session.mode,
        provider: session.provider ?? "default",
        model: session.model ?? "",
        permissions,
        workdir,
      }).map((line) => ansiToStyledText(line.length === 0 ? " " : line)),
    [
      width,
      version,
      session.mode,
      session.provider,
      session.model,
      permissions,
      workdir,
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
