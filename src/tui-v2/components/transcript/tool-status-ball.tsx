/** @jsxImportSource @opentui/react */

import { useEffect, useState, type ReactNode } from "react";
import type { ToolStatus } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { ColorMode } from "../../../app/ports/terminal-port.js";
import { TOOL_BALL_INTERVAL_MS, TOOL_BALL_WIDTH, toolStatusBall } from "../../../ui-core/rendering/tool-status-ball.js";
import { ansiToStyledText } from "../../rendering/ansi-to-styled.js";

export function ToolStatusBall(props: {
  status: ToolStatus;
  theme: Theme;
  colorMode: ColorMode;
  unicode: boolean;
  reducedMotion: boolean;
}): ReactNode {
  const { status, theme, colorMode, unicode, reducedMotion } = props;
  const [now, setNow] = useState(() => Date.now());
  const active = !reducedMotion && (status === "running" || status === "queued");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), TOOL_BALL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);
  const content = ansiToStyledText(toolStatusBall(status, now, theme, colorMode, unicode));
  return <text content={content} selectable={false} wrapMode="none" style={{ width: TOOL_BALL_WIDTH, height: 1, flexShrink: 0 }} />;
}
