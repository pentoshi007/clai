import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TermSize {
  columns: number;
  rows: number;
}

/**
 * Tracks the terminal size and updates on SIGWINCH-style resize events so the
 * full-screen layout can reflow and keep the composer pinned to the bottom.
 */
export function useTerminalSize(): TermSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TermSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
