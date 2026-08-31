const SUPPRESSED_CONSOLE_PATTERNS: readonly RegExp[] = [
  /Possible EventTarget memory leak detected/i,
  /Cannot update a component/i,
  /while rendering a different component/i,
];

export function isSuppressedConsoleMessage(message: string): boolean {
  return SUPPRESSED_CONSOLE_PATTERNS.some((re) => re.test(message));
}