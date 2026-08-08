/**
 * Console messages that must never surface as toasts. These are runtime
 * diagnostics (Node's EventTarget max-listeners warning and React's
 * setState-in-render warning — the latter prints raw `%s` placeholders because
 * the console guard does not do printf-style substitution). They are still
 * written to the tui-console.log for debugging, but never shown in the TUI.
 */
const SUPPRESSED_CONSOLE_PATTERNS: readonly RegExp[] = [
  /Possible EventTarget memory leak detected/i,
  /Cannot update a component/i,
  /while rendering a different component/i,
];

export function isSuppressedConsoleMessage(message: string): boolean {
  return SUPPRESSED_CONSOLE_PATTERNS.some((re) => re.test(message));
}