import type { CatalogFacts } from "./catalog-facts.js";
import type { RiverDocFacts } from "./river-models.js";

const DOCS_ORIGIN = "https://docs.river.ai";
const LIMITS_URL = `${DOCS_ORIGIN}/guides/inference-models.md`;
const CONTROLS_URL = `${DOCS_ORIGIN}/guides/inference-controls.md`;
const OFFICIAL_API_HOST = "api.river.ai";
const FETCH_TIMEOUT_MS = 4_000;
const MAX_DOC_CHARS = 512 * 1024;
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MIN_CONTEXT_TOKENS = 8_192;
const MAX_CONTEXT_TOKENS = 16_777_216;
const EFFORT_VOCABULARY = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface LimitsRow {
  readonly id: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number | undefined;
}

interface ControlsRow {
  readonly name: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | undefined;
}

let cached: { expiresAt: number; facts: RiverDocFacts } | undefined;
let pending: Promise<RiverDocFacts> | undefined;

function splitRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return undefined;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function tableRows(markdown: string, firstHeader: RegExp): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const cells = splitRow(line);
    return cells !== undefined && firstHeader.test(cells[0] ?? "");
  });
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    const cells = splitRow(line);
    if (!cells) break;
    rows.push(cells);
  }
  return rows;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
}

function tokenCount(cell: string | undefined): number | undefined {
  const match = /^([\d,]+)\s*(K)?\b/i.exec(cell?.trim() ?? "");
  if (!match) return undefined;
  const digits = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isSafeInteger(digits) || digits <= 0) return undefined;
  return match[2] ? digits * 1_000 : digits;
}

export function parseRiverLimitsTable(markdown: string): LimitsRow[] {
  const rows: LimitsRow[] = [];
  for (const cells of tableRows(markdown, /^model id$/i)) {
    const id = backticked(cells[0] ?? "")[0];
    const contextTokens = tokenCount(cells[1]);
    if (!id || contextTokens === undefined) continue;
    if (contextTokens < MIN_CONTEXT_TOKENS || contextTokens > MAX_CONTEXT_TOKENS) continue;
    const maxOutput = tokenCount(cells[2]);
    rows.push({
      id,
      contextTokens,
      maxOutputTokens:
        maxOutput !== undefined && maxOutput <= contextTokens ? maxOutput : undefined,
    });
  }
  return rows;
}

export function parseRiverControlsTable(markdown: string): ControlsRow[] {
  const rows: ControlsRow[] = [];
  for (const cells of tableRows(markdown, /^model$/i)) {
    const name = (cells[0] ?? "").replace(/`/g, "").trim();
    const efforts = [
      ...new Set(
        backticked(cells[2] ?? "")
          .map((effort) => effort.toLowerCase())
          .filter((effort) => EFFORT_VOCABULARY.has(effort)),
      ),
    ];
    if (!name || efforts.length === 0) continue;
    const defaultEffort = backticked(cells[1] ?? "")
      .map((effort) => effort.toLowerCase())
      .find((effort) => EFFORT_VOCABULARY.has(effort) && efforts.includes(effort));
    rows.push({ name, efforts, defaultEffort });
  }
  return rows;
}

function shortName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

export function riverDocFactsFromMarkdown(
  limitsMarkdown: string,
  controlsMarkdown: string,
): RiverDocFacts {
  const controls = new Map(
    parseRiverControlsTable(controlsMarkdown).map((row) => [row.name.toLowerCase(), row]),
  );
  const facts = new Map<string, CatalogFacts>();
  for (const limits of parseRiverLimitsTable(limitsMarkdown)) {
    const control = controls.get(shortName(limits.id));
    facts.set(limits.id.toLowerCase(), {
      id: limits.id,
      contextTokens: limits.contextTokens,
      ...(limits.maxOutputTokens !== undefined
        ? { maxOutputTokens: limits.maxOutputTokens }
        : {}),
      ...(control
        ? {
            reasoning: {
              supported: true,
              mandatory: !control.efforts.includes("none"),
              supportedEfforts: control.efforts,
              ...(control.defaultEffort ? { defaultEffort: control.defaultEffort } : {}),
            },
          }
        : {}),
    });
  }
  return facts;
}

export function isOfficialRiverEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === OFFICIAL_API_HOST;
  } catch {
    return false;
  }
}

async function fetchMarkdown(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`River docs returned ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_DOC_CHARS) throw new Error("River docs response too large");
  return text;
}

async function fetchRiverDocFacts(): Promise<RiverDocFacts> {
  const [limits, controls] = await Promise.all([
    fetchMarkdown(LIMITS_URL),
    fetchMarkdown(CONTROLS_URL),
  ]);
  return riverDocFactsFromMarkdown(limits, controls);
}

export function loadRiverDocFacts(): Promise<RiverDocFacts> {
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.facts);
  if (pending) return pending;
  const task = fetchRiverDocFacts()
    .then((facts) => {
      cached = { expiresAt: Date.now() + SUCCESS_TTL_MS, facts };
      return facts;
    })
    .catch((): RiverDocFacts => {
      const facts = cached?.facts ?? new Map();
      cached = { expiresAt: Date.now() + FAILURE_TTL_MS, facts };
      return facts;
    })
    .finally(() => {
      pending = undefined;
    });
  pending = task;
  return task;
}

export function resetRiverDocFacts(): void {
  cached = undefined;
  pending = undefined;
}
