import { createHash, type Hash } from "node:crypto";

import type {
  GenerationAttemptInput,
  RequestFingerprintPrefix,
  RequestFingerprintSection,
  RequestFingerprintSectionKind,
  RequestFingerprintSerializerId,
  RequestFingerprintV1,
} from "../types.js";

export const REQUEST_FINGERPRINT_VERSION = 1 as const;
export const REQUEST_FINGERPRINT_SERIALIZER_VERSION = 1 as const;

type JsonField = {
  readonly name: string;
  readonly start: number;
  readonly valueStart: number;
  readonly end: number;
};

type JsonRange = {
  readonly start: number;
  readonly end: number;
};

type SectionAccumulator = {
  readonly kind: RequestFingerprintSectionKind;
  readonly hash: Hash;
  byteLength: number;
  itemCount: number;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function updateChunk(hash: Hash, value: string): number {
  const bytes = byteLength(value);
  hash.update(`${bytes}:`, "utf8");
  hash.update(value, "utf8");
  return bytes;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function chainedSha256(previous: string | undefined, value: string): string {
  const hash = createHash("sha256");
  hash.update("clai.request-fingerprint.prefix.v1\0", "utf8");
  if (previous) hash.update(previous, "hex");
  updateChunk(hash, value);
  return hash.digest("hex");
}

function skipWhitespace(source: string, index: number): number {
  let next = index;
  while (next < source.length && /\s/.test(source[next]!)) next += 1;
  return next;
}

function scanJsonString(source: string, start: number): number {
  if (source[start] !== '"') throw new Error("expected JSON string");
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  throw new Error("unterminated JSON string");
}

function scanJsonValue(source: string, start: number): number {
  const first = source[start];
  if (first === '"') return scanJsonString(source, start);
  if (first !== "{" && first !== "[") {
    let end = start;
    while (end < source.length && !/[\s,}\]]/.test(source[end]!)) end += 1;
    if (end === start) throw new Error("expected JSON value");
    return end;
  }

  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("unterminated JSON value");
}

function rootJsonFields(source: string): readonly JsonField[] {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") throw new Error("expected JSON object");
  index = skipWhitespace(source, index + 1);
  const fields: JsonField[] = [];
  while (source[index] !== "}") {
    const start = index;
    const keyEnd = scanJsonString(source, index);
    const name = JSON.parse(source.slice(index, keyEnd)) as string;
    index = skipWhitespace(source, keyEnd);
    if (source[index] !== ":") throw new Error("expected JSON field separator");
    const valueStart = skipWhitespace(source, index + 1);
    const end = scanJsonValue(source, valueStart);
    fields.push({ name, start, valueStart, end });
    index = skipWhitespace(source, end);
    if (source[index] === ",") {
      index = skipWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "}") break;
    throw new Error("expected JSON field delimiter");
  }
  if (skipWhitespace(source, index + 1) !== source.length) {
    throw new Error("unexpected JSON suffix");
  }
  return fields;
}

function arrayElements(source: string, range: JsonRange): readonly JsonRange[] {
  let index = skipWhitespace(source, range.start);
  if (source[index] !== "[") return [];
  index = skipWhitespace(source, index + 1);
  const elements: JsonRange[] = [];
  while (source[index] !== "]") {
    const start = index;
    const end = scanJsonValue(source, start);
    elements.push({ start, end });
    index = skipWhitespace(source, end);
    if (source[index] === ",") {
      index = skipWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "]") break;
    throw new Error("expected JSON array delimiter");
  }
  return elements;
}

function sectionKind(fieldName: string): RequestFingerprintSectionKind {
  if (fieldName === "system" || fieldName === "systemInstruction") {
    return "instructions";
  }
  if (fieldName === "tools") return "tools";
  if (fieldName === "messages" || fieldName === "contents" || fieldName === "input") {
    return "history";
  }
  return "settings";
}

function serializerId(
  input: Pick<GenerationAttemptInput, "provider" | "model">,
): RequestFingerprintSerializerId {
  switch (input.provider) {
    case "anthropic":
      return "anthropic-messages";
    case "gemini":
      return "gemini-generate-content";
    case "meta":
      return "meta-responses";
    case "ollama":
      return "ollama-chat";
    case "aws-mantle":
      return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(input.model)
        ? "anthropic-messages"
        : "chat-completions";
    default:
      return "chat-completions";
  }
}

function freezeFingerprint(
  serializer: RequestFingerprintSerializerId,
  body: { byteLength: number; sha256: string },
  sections: readonly RequestFingerprintSection[],
  prefixes: readonly RequestFingerprintPrefix[],
): RequestFingerprintV1 {
  return Object.freeze({
    version: REQUEST_FINGERPRINT_VERSION,
    serializer: Object.freeze({
      id: serializer,
      version: REQUEST_FINGERPRINT_SERIALIZER_VERSION,
    }),
    body: Object.freeze({ ...body }),
    sections: Object.freeze(sections.map((section) => Object.freeze({ ...section }))),
    prefixes: Object.freeze(prefixes.map((prefix) => Object.freeze({ ...prefix }))),
  });
}

function wireOnlyFingerprint(
  input: Pick<GenerationAttemptInput, "provider" | "model">,
  body: string,
): RequestFingerprintV1 {
  return freezeFingerprint(
    serializerId(input),
    { byteLength: byteLength(body), sha256: sha256(body) },
    [],
    [
      {
        ordinal: 1,
        section: "wire",
        boundary: "wire",
        byteLength: byteLength(body),
        sha256: sha256(body),
      },
    ],
  );
}

/**
 * Captures hashes and byte counts from the exact JSON string passed to fetch.
 * The returned value has no request body, header, URL, or decoded JSON values.
 */
export function fingerprintFinalRequest(
  input: Pick<GenerationAttemptInput, "provider" | "model">,
  body: BodyInit | null | undefined,
): RequestFingerprintV1 | undefined {
  if (typeof body !== "string") return undefined;
  try {
    JSON.parse(body);
    const fields = rootJsonFields(body);
    const sections = new Map<RequestFingerprintSectionKind, SectionAccumulator>();
    const sectionOrder: SectionAccumulator[] = [];
    const appendSection = (
      kind: RequestFingerprintSectionKind,
      value: string,
      itemCount = 0,
    ): void => {
      let section = sections.get(kind);
      if (!section) {
        section = {
          kind,
          hash: createHash("sha256").update(
            `clai.request-fingerprint.section.${kind}.v1\0`,
            "utf8",
          ),
          byteLength: 0,
          itemCount: 0,
        };
        sections.set(kind, section);
        sectionOrder.push(section);
      }
      section.byteLength += updateChunk(section.hash, value);
      section.itemCount += itemCount;
    };

    const boundaries: Array<{
      end: number;
      section: RequestFingerprintPrefix["section"];
      boundary: RequestFingerprintPrefix["boundary"];
      historyItems?: number | undefined;
    }> = [];

    for (const field of fields) {
      const kind = sectionKind(field.name);
      const fieldValue = body.slice(field.start, field.end);
      const history =
        kind === "history"
          ? arrayElements(body, { start: field.valueStart, end: field.end })
          : [];
      appendSection(kind, fieldValue, history.length);
      for (let index = 0; index < history.length; index += 1) {
        boundaries.push({
          end: history[index]!.end,
          section: "history",
          boundary: "history-item",
          historyItems: index + 1,
        });
      }
      boundaries.push({
        end: field.end,
        section: kind,
        boundary: "field",
        ...(kind === "history" ? { historyItems: history.length } : {}),
      });
    }
    boundaries.push({
      end: body.length,
      section: "wire",
      boundary: "wire",
    });

    let cursor = 0;
    let previous: string | undefined;
    let prefixBytes = 0;
    const prefixes: RequestFingerprintPrefix[] = [];
    for (const boundary of boundaries) {
      const chunk = body.slice(cursor, boundary.end);
      prefixBytes += byteLength(chunk);
      previous = chainedSha256(previous, chunk);
      prefixes.push({
        ordinal: prefixes.length + 1,
        section: boundary.section,
        boundary: boundary.boundary,
        byteLength: prefixBytes,
        sha256: previous,
        ...(boundary.historyItems !== undefined
          ? { historyItems: boundary.historyItems }
          : {}),
      });
      cursor = boundary.end;
    }

    const sectionFingerprints: RequestFingerprintSection[] = sectionOrder.map(
      (section) => ({
        section: section.kind,
        byteLength: section.byteLength,
        sha256: section.hash.digest("hex"),
        ...(section.kind === "history" ? { itemCount: section.itemCount } : {}),
      }),
    );
    return freezeFingerprint(
      serializerId(input),
      { byteLength: byteLength(body), sha256: sha256(body) },
      sectionFingerprints,
      prefixes,
    );
  } catch {
    return wireOnlyFingerprint(input, body);
  }
}

export type PrefixAffinityClassification =
  | "exact_append_eligible"
  | "partial_prefix_eligible"
  | "not_eligible"
  | "unknown";

function historyItemPrefix(
  fingerprint: RequestFingerprintV1,
  historyItems: number,
): RequestFingerprintPrefix | undefined {
  return fingerprint.prefixes.find(
    (prefix) =>
      prefix.section === "history" &&
      prefix.boundary === "history-item" &&
      prefix.historyItems === historyItems,
  );
}

function stableHistoryItems(fingerprint: RequestFingerprintV1): number {
  return fingerprint.prefixes.reduce(
    (largest, prefix) =>
      prefix.section === "history" &&
      prefix.boundary === "history-item" &&
      prefix.historyItems !== undefined &&
      prefix.historyItems > largest
        ? prefix.historyItems
        : largest,
    0,
  );
}

function sectionSha256(
  fingerprint: RequestFingerprintV1,
  section: RequestFingerprintSectionKind,
): string | undefined {
  return fingerprint.sections.find((entry) => entry.section === section)
    ?.sha256;
}

export function classifyPrefixAffinity(
  prior: RequestFingerprintV1 | undefined,
  next: RequestFingerprintV1 | undefined,
): PrefixAffinityClassification {
  if (!prior || !next) return "unknown";
  if (prior.serializer.id !== next.serializer.id) return "not_eligible";
  const items = stableHistoryItems(prior);
  if (items === 0) return "unknown";
  const priorPrefix = historyItemPrefix(prior, items);
  const nextPrefix = historyItemPrefix(next, items);
  if (!priorPrefix || !nextPrefix) return "unknown";
  if (
    sectionSha256(prior, "instructions") !==
      sectionSha256(next, "instructions") ||
    sectionSha256(prior, "tools") !== sectionSha256(next, "tools")
  ) {
    return "not_eligible";
  }
  if (priorPrefix.sha256 === nextPrefix.sha256) {
    return "exact_append_eligible";
  }
  return "partial_prefix_eligible";
}
