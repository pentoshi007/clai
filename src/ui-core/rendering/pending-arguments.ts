export const PENDING_ARGUMENTS_INTERVAL_MS = 1000;

export function pendingArgumentsText(elapsedMs: number): string {
  const dots = Math.floor(Math.max(0, elapsedMs) / PENDING_ARGUMENTS_INTERVAL_MS) % 3 + 1;
  return `receiving arguments ${".".repeat(dots)}`;
}
