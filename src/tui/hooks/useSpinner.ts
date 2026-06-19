import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Returns the current spinner glyph, advancing on a timer while `active`.
 * No-op (and steady frame) when inactive so idle renders stay still.
 */
export function useSpinner(active: boolean, intervalMs = 80): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return FRAMES[active ? frame : 0]!;
}
