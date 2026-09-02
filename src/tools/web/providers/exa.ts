
import { Buffer } from "node:buffer";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./provider.js";
import {
  DEFAULT_EXA_SEARCH_TYPE,
  type ExaSearchType,
} from "../types.js";
import { getExaSearchType } from "../../../store/config.js";


const EXA_HOST = "api.exa.ai";
const EXA_PATH = "/search";

const EXA_MIN_RESULTS = 1;
const EXA_MAX_RESULTS = 20;

const DEFAULT_USER_AGENT = "clai-web-search/1.0";

const MAX_RESPONSE_BYTES = 4_194_304;


type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

export function __setExaHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

let searchTypeResolver: () => ExaSearchType = defaultSearchTypeResolver;

function defaultSearchTypeResolver(): ExaSearchType {
  try {
    return getExaSearchType();
  } catch {
    return DEFAULT_EXA_SEARCH_TYPE;
  }
}

export function __setExaSearchTypeResolverForTesting(
  resolver: (() => ExaSearchType) | undefined,
): void {
  searchTypeResolver = resolver ?? defaultSearchTypeResolver;
}

function clampResults(count: number): number {
  if (!Number.isFinite(count)) return EXA_MIN_RESULTS;
  const rounded = Math.trunc(count);
  if (rounded < EXA_MIN_RESULTS) return EXA_MIN_RESULTS;
  if (rounded > EXA_MAX_RESULTS) return EXA_MAX_RESULTS;
  return rounded;
}

function readBody(res: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      res.destroy(new Error("aborted"));
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    res.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        aborted = true;
        signal.removeEventListener("abort", onAbort);
        res.destroy();
        reject(new Error("response body exceeded 4 MiB cap"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (aborted) return;
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function buildPayload(
  query: string,
  numResults: number,
  type: ExaSearchType,
): string {
  const body: Record<string, unknown> = { query, type, numResults };
  if (type !== "instant") {
    body.contents = { highlights: true };
  }
  return JSON.stringify(body);
}

function dispatchRequest(
  query: string,
  numResults: number,
  type: ExaSearchType,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const payload = buildPayload(query, numResults, type);
  const bodyBytes = Buffer.from(payload, "utf8");

  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    try {
      req = httpsRequestFn(
        {
          method: "POST",
          host: EXA_HOST,
          path: EXA_PATH,
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": String(bodyBytes.length),
            "user-agent": DEFAULT_USER_AGENT,
            "x-api-key": apiKey,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          readBody(res, signal).then(
            (body) => resolve({ status, body }),
            (err) => reject(err),
          );
        },
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.on("error", (err) => {
      reject(err);
    });

    req.write(bodyBytes);
    req.end();
  });
}

function extractSnippet(entry: {
  highlights?: unknown;
  text?: unknown;
  summary?: unknown;
}): string {
  if (Array.isArray(entry.highlights)) {
    const joined = entry.highlights
      .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      .join(" … ");
    if (joined) return joined;
  }
  if (typeof entry.text === "string" && entry.text.trim()) return entry.text;
  if (typeof entry.summary === "string" && entry.summary.trim()) {
    return entry.summary;
  }
  return "";
}

function extractHits(parsed: unknown): RawProviderResponse["hits"] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const hits: RawProviderResponse["hits"] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      highlights?: unknown;
      text?: unknown;
      summary?: unknown;
    };
    const hit: RawProviderResponse["hits"][number] = {};
    if (typeof e.title === "string") hit.title = e.title;
    if (typeof e.url === "string") hit.url = e.url;
    const snippet = extractSnippet(e);
    if (snippet) hit.snippet = snippet;
    hits.push(hit);
  }
  return hits;
}


export const exaProvider: SearchProvider = {
  id: "exa",
  displayName: "Exa",
  needsApiKey: true,
  envVar: "EXA_API_KEY",

  async search(
    query: string,
    maxResults: number,
    auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    if (!auth.apiKey) {
      return { status: 0, hits: [], parseError: "missing api key" };
    }

    const numResults = clampResults(maxResults);
    const type = searchTypeResolver();
    const { status, body } = await dispatchRequest(
      query,
      numResults,
      type,
      auth.apiKey,
      signal,
    );

    if (status < 200 || status >= 300) {
      return { status, hits: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        status,
        hits: [],
        parseError:
          err instanceof Error
            ? `non-JSON response: ${err.message}`
            : "non-JSON response",
      };
    }

    const hits = extractHits(parsed);
    if (hits === null) {
      return {
        status,
        hits: [],
        parseError: "missing results array in Exa response",
      };
    }

    return { status, hits };
  },
};

searchProviders.exa = exaProvider;
