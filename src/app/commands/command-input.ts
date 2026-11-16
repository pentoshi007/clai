const INVISIBLE_FORMAT = /[\p{Cf}\u180e]/gu;
const LEADING_FILLER = /^[\s\p{Cf}\u180e]+/u;
const LEADING_SLASHES = /^[/\uff0f\u2215\u2044\u29f8]+/u;
const SLASH_LOOKALIKES: ReadonlySet<string> = new Set(["\uff0f", "\u2215", "\u2044", "\u29f8"]);
const COMMAND_TOKEN = /^[a-z][a-z0-9-]*$/i;

export function stripInvisibleFormat(text: string): string {
  return text.replace(INVISIBLE_FORMAT, "");
}

export function stripLeadingSlashes(text: string): string {
  return text.replace(LEADING_SLASHES, "");
}

export function isBlankInput(text: string): boolean {
  return stripInvisibleFormat(text).trim().length === 0;
}

export function isSlashLookalike(char: string | undefined): boolean {
  return char !== undefined && SLASH_LOOKALIKES.has(char);
}

export function isCommandSlash(char: string | undefined): boolean {
  return char === "/" || isSlashLookalike(char);
}

export interface CommandInputParts {
  readonly slash: string;
  readonly token: string;
  readonly rest: string;
}

export function splitCommandInput(line: string): CommandInputParts | undefined {
  const text = line.replace(LEADING_FILLER, "");
  const slash = text[0];
  if (slash === undefined || !isCommandSlash(slash)) return undefined;
  const body = text.slice(1);
  const boundary = body.search(/\s/);
  const rawToken = boundary === -1 ? body : body.slice(0, boundary);
  const rest = boundary === -1 ? "" : body.slice(boundary);
  return { slash, token: stripInvisibleFormat(rawToken), rest };
}

export function isCommandShapedToken(token: string): boolean {
  return COMMAND_TOKEN.test(token);
}
