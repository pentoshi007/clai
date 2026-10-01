import { isInternalChatMessage, type ChatMessage } from "../../types.js";

export const USER_CREDENTIALS_HEADING =
  "User-provided credentials (verbatim from the user; use only for the work the user requested):";

const MAX_CREDENTIALS = 16;
const MAX_LINE_CHARS = 600;
const MAX_COMPANION_LINES = 3;
const CONTEXT_CHARS = 80;
const REDACTION_MARKERS: readonly string[] = ["••••", "[redacted]"];

const SECRET_QUALIFIERS =
  "api|access|secret|private|auth|license|signing|encryption|client|app|test|live|publishable|webhook|bearer|session|refresh";

const SPOKEN_SECRET = String.raw`\b(?:${SECRET_QUALIFIERS})[\s_-]?(?:key|secret|token)s?\b[\s"'\x60]{0,4}(?:is|are|=|:)[\s"'\x60]{0,4}(?=[^\s"'\x60]*\d)[^\s"'\x60]{8,}`;

const CREDENTIAL_PATTERN = new RegExp(
  [
    String.raw`\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`,
    String.raw`\bsk-[A-Za-z0-9._-]{16,}`,
    String.raw`\b(?:gsk|hf|r8|glpat|npm|tvly|pplx|xai|nvapi|fw|thk)[_-][A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\bA(?:KIA|SIA)[0-9A-Z]{16}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{16,}`,
    String.raw`\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,256}:[^\s@/]{1,256}@\S+`,
    String.raw`\b[\w.-]{0,40}(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passphrase|pwd|credentials?|access[_-]?key|private[_-]?key)[\w.-]{0,40}["']?\s{0,8}[:=]\s{0,8}["'\x60]?[^\s"'\x60]{4,}`,
    String.raw`\b(?:password|passphrase|passcode|pin)\s+is\s+\S{4,}`,
    SPOKEN_SECRET,
  ].join("|"),
  "gi",
);

const IDENTITY_LINE = new RegExp(
  String.raw`^(?:user(?:name)?|login|e-?mail|account(?:[\s_-]?(?:id|name))?|host(?:name)?|url|endpoint|base[\s_-]?url|tenant|project(?:[\s_-]?id)?|region|client[\s_-]?id|org(?:anization)?(?:[\s_-]?id)?|database|db(?:[\s_-]?name)?|port)\s*[:=]\s*\S`,
  "i",
);

const windowsAround = (line: string): string[] =>
  [...line.matchAll(CREDENTIAL_PATTERN)].map((match) => {
    const start = Math.max(0, match.index - CONTEXT_CHARS);
    const end = match.index + match[0].length;
    return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
  });

const hasCredential = (line: string): boolean => {
  CREDENTIAL_PATTERN.lastIndex = 0;
  const found = CREDENTIAL_PATTERN.test(line);
  CREDENTIAL_PATTERN.lastIndex = 0;
  return found;
};

const companionIndexes = (
  lines: readonly string[],
  anchor: number,
  direction: 1 | -1,
): number[] => {
  const found: number[] = [];
  for (
    let cursor = anchor + direction;
    found.length < MAX_COMPANION_LINES && IDENTITY_LINE.test(lines[cursor] ?? "");
    cursor += direction
  ) {
    found.push(cursor);
  }
  return found;
};

const credentialLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/).map((raw) => raw.trim());
  const secrets = new Set(
    lines.flatMap((line, index) => (line && hasCredential(line) ? [index] : [])),
  );
  const included = new Set(secrets);
  for (const anchor of secrets) {
    for (const direction of [-1, 1] as const) {
      for (const index of companionIndexes(lines, anchor, direction)) included.add(index);
    }
  }
  return [...included]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const line = lines[index]!;
      if (line.length <= MAX_LINE_CHARS) return [line];
      return secrets.has(index) ? windowsAround(line) : [line.slice(0, MAX_LINE_CHARS)];
    });
};

const carriedCredentials = (content: string): string[] => {
  const lines = content.split("\n");
  const start = lines.indexOf(USER_CREDENTIALS_HEADING);
  if (start < 0) return [];
  const carried: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("- ")) break;
    carried.push(line.slice(2));
  }
  return carried;
};

export function collectUserCredentials(
  messages: readonly ChatMessage[],
  isEnvelope: (content: string) => boolean,
): string[] {
  const found = messages.flatMap((message) => {
    if (message.role === "system" && isEnvelope(message.content)) {
      return carriedCredentials(message.content);
    }
    if (message.role !== "user" || isInternalChatMessage(message)) return [];
    return credentialLines(message.content);
  });
  const unique = [
    ...new Set(found.filter((line) => !REDACTION_MARKERS.some((marker) => line.includes(marker)))),
  ];
  return unique.slice(-MAX_CREDENTIALS);
}

export function renderUserCredentials(credentials: readonly string[]): string[] {
  return credentials.length > 0
    ? [USER_CREDENTIALS_HEADING, ...credentials.map((line) => `- ${line}`)]
    : [];
}
