const SHELL_SAFE_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuoteToken(token: string): string {
  if (SHELL_SAFE_TOKEN_RE.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
