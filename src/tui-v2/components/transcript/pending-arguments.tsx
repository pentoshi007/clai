/** @jsxImportSource @opentui/react */

import { useEffect, useState, type ReactNode } from "react";
import { pendingArgumentsText, PENDING_ARGUMENTS_INTERVAL_MS } from "../../../ui-core/rendering/pending-arguments.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { LinkableText } from "./linkable-text.js";

export function PendingArguments({ theme }: { theme: Theme }): ReactNode {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(value => (value + PENDING_ARGUMENTS_INTERVAL_MS) % (3 * PENDING_ARGUMENTS_INTERVAL_MS));
    }, PENDING_ARGUMENTS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return <LinkableText text={pendingArgumentsText(elapsed)} theme={theme} fg={theme.mode} selectable />;
}
