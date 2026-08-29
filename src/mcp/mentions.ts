export interface McpMentionRange {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

const TOKEN_RE = /(^|[^\w:/\\.-])@mcp:([A-Za-z0-9][A-Za-z0-9_./-]*)/g;
const TRAILING_PUNCTUATION = /[._/-]+$/;

export function formatMcpToken(name: string): string {
  return `@mcp:${name}`;
}

export function hasMcpMentionSyntax(text: string): boolean {
  return text.includes("@mcp:");
}

function resolveName(raw: string, known: ReadonlySet<string>): string | undefined {
  let candidate = raw;
  while (candidate.length > 0) {
    if (known.has(candidate)) return candidate;
    const trimmed = candidate.replace(TRAILING_PUNCTUATION, "");
    if (trimmed === candidate) return undefined;
    candidate = trimmed;
  }
  return undefined;
}

export function findMcpMentions(
  text: string,
  known: ReadonlySet<string>,
): McpMentionRange[] {
  if (!text || known.size === 0 || !hasMcpMentionSyntax(text)) return [];
  const out: McpMentionRange[] = [];
  const pattern = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const raw = match[2] ?? "";
    const name = resolveName(raw, known);
    if (!name) continue;
    const start = match.index + lead.length;
    out.push({ start, end: start + formatMcpToken(name).length, name });
  }
  return out;
}

export function mcpMentionNames(
  text: string,
  known: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  for (const mention of findMcpMentions(text, known)) seen.add(mention.name);
  return [...seen];
}
