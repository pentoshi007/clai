export function tokenInsertion(textBeforeCaret: string, token: string): string {
  const needsSpace =
    textBeforeCaret.length > 0 && !/[\s([{"'`]$/.test(textBeforeCaret);
  return needsSpace ? ` ${token}` : token;
}
