export interface SkillMentionRange {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

const TOKEN_RE = /(^|[^\w:/\\.-])skill:([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function formatSkillToken(name: string): string {
  return `skill:${name}`;
}

export function findSkillMentions(
  text: string,
  known: ReadonlySet<string>,
): SkillMentionRange[] {
  if (!text || known.size === 0 || !text.includes("skill:")) return [];
  const out: SkillMentionRange[] = [];
  const pattern = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const raw = match[2] ?? "";
    const name = raw.toLowerCase().replace(/_/g, "-");
    if (!known.has(name)) continue;
    const start = match.index + lead.length;
    out.push({ start, end: start + `skill:${raw}`.length, name });
  }
  return out;
}

export function skillMentionNames(
  text: string,
  known: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  for (const mention of findSkillMentions(text, known)) seen.add(mention.name);
  return [...seen];
}

export function hasSkillMention(
  text: string,
  known: ReadonlySet<string>,
): boolean {
  return findSkillMentions(text, known).length > 0;
}
