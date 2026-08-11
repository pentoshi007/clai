/**
 * Shared easing for terminal UI motion (toasts, task pane, …).
 * Discrete row steps + ease curves read as “smooth” in a TUI.
 */

export function clamp01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/** easeOutCubic — quick start, soft settle (enter). */
export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

/** easeInCubic — soft start into exit. */
export function easeInCubic(t: number): number {
  const x = clamp01(t);
  return x * x * x;
}
