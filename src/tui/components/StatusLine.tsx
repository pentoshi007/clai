import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { TurnStatus } from "../state.js";
import { useSpinner } from "../hooks/useSpinner.js";

export interface StatusLineProps {
  status: TurnStatus;
  thinkingPreview: string;
  queued: number;
}

function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function StatusLine({ status, thinkingPreview, queued }: StatusLineProps) {
  const spinner = useSpinner(status.running);
  const elapsed = useElapsed(status.running ? status.startedAt : undefined);
  if (!status.running) {
    return (
      <Box>
        <Text dimColor>
          {"  "}ready{queued > 0 ? `  ·  ${queued} queued` : ""}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="magenta">
          {"  "}
          {spinner}{" "}
        </Text>
        <Text color="yellow">{status.activity || "working"}</Text>
        {status.step > 0 ? <Text dimColor>{`  ·  step ${status.step}`}</Text> : null}
        <Text dimColor>{`  ·  ${elapsed}s`}</Text>
        {queued > 0 ? <Text dimColor>{`  ·  ${queued} queued`}</Text> : null}
        <Text dimColor>{"  ·  esc to cancel"}</Text>
      </Box>
      {thinkingPreview ? (
        <Text dimColor italic>
          {"    "}
          {thinkingPreview.slice(-120)}
        </Text>
      ) : null}
    </Box>
  );
}
