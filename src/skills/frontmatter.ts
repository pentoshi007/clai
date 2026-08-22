export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly body: string;
  readonly present: boolean;
}

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_.-]*):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]*-[ \t]*(.*)$/;
const EMPTY_FRONTMATTER: Frontmatter = {
  fields: {},
  lists: {},
  body: "",
  present: false,
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

function indentOf(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") count += 1;
    else if (char === "\t") count += 2;
    else break;
  }
  return count;
}

function splitFlowList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((part) => unquote(part))
    .filter((part) => part.length > 0);
}

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim().length === 0) cursor += 1;
  if (lines[cursor]?.trim() !== "---") {
    return { ...EMPTY_FRONTMATTER, body: text.trim() };
  }
  let end = -1;
  for (let index = cursor + 1; index < lines.length; index += 1) {
    const candidate = lines[index]!.trim();
    if (candidate === "---" || candidate === "...") {
      end = index;
      break;
    }
  }
  if (end < 0) return { ...EMPTY_FRONTMATTER, body: text.trim() };

  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const region = lines.slice(cursor + 1, end);

  for (let index = 0; index < region.length; index += 1) {
    const line = region[index]!;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (indentOf(line) > 0) continue;
    const match = KEY_LINE.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const rawValue = match[2] ?? "";
    const scalar = rawValue.trim();

    if (scalar === "|" || scalar === "|-" || scalar === ">" || scalar === ">-") {
      const folded = scalar.startsWith(">");
      const collected: string[] = [];
      let look = index + 1;
      while (look < region.length) {
        const next = region[look]!;
        if (next.trim().length > 0 && indentOf(next) === 0) break;
        collected.push(next.trim());
        look += 1;
      }
      index = look - 1;
      const joined = folded
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
      fields[key] = joined;
      continue;
    }

    if (scalar.startsWith("[") && scalar.endsWith("]")) {
      const items = splitFlowList(scalar);
      lists[key] = items;
      fields[key] = items.join(" ");
      continue;
    }

    if (scalar.length === 0) {
      const items: string[] = [];
      const nested: string[] = [];
      let look = index + 1;
      while (look < region.length) {
        const next = region[look]!;
        if (next.trim().length === 0) {
          look += 1;
          continue;
        }
        if (indentOf(next) === 0) break;
        const item = LIST_ITEM.exec(next);
        if (item) items.push(unquote(item[1] ?? ""));
        else {
          const child = KEY_LINE.exec(next.trim());
          if (child) nested.push(`${child[1]}=${unquote(child[2] ?? "")}`);
        }
        look += 1;
      }
      index = look - 1;
      if (items.length > 0) {
        lists[key] = items.filter((item) => item.length > 0);
        fields[key] = lists[key]!.join(" ");
      } else if (nested.length > 0) {
        fields[key] = nested.join(" ");
      }
      continue;
    }

    fields[key] = unquote(scalar);
  }

  return {
    fields,
    lists,
    body: lines.slice(end + 1).join("\n").trim(),
    present: true,
  };
}

export function frontmatterList(
  parsed: Frontmatter,
  key: string,
): string[] | undefined {
  const direct = parsed.lists[key];
  if (direct && direct.length > 0) return [...direct];
  const scalar = parsed.fields[key];
  if (!scalar) return undefined;
  const items = scalar
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}
