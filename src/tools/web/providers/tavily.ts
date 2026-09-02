
import { Buffer } from "node:buffer";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./provider.js";


const TAVILY_HOST = "api.tavily.com";
const TAVILY_PATH = "/search";

const TAVILY_MIN_RESULTS = 1;
const TAVILY_MAX_RESULTS = 20;

const TAVILY_SEARCH_DEPTH = "basic";

const DEFAULT_USER_AGENT = "clai-web-search/1.0";

const MAX_RESPONSE_BYTES = 1_048_576;


type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

export function __setTavilyHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

function clampMaxResults(count: number): number {
  if (!Number.isFinite(count)) return TAVILY_MIN_RESULTS;
  const rounded = Math.trunc(count);
  if (rounded < TAVILY_MIN_RESULTS) return TAVILY_MIN_RESULTS;
  if (rounded > TAVILY_MAX_RESULTS) return TAVILY_MAX_RESULTS;
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
        signal.reason instanceof Error
          ? signal.reason
          : new Error("aborted"),
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
        reject(new Error("response body exceeded 1 MiB cap"));
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

function dispatchRequest(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: TAVILY_SEARCH_DEPTH,
  });
  const bodyBytes = Buffer.from(payload, "utf8");

  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    try {
      req = httpsRequestFn(
        {
          method: "POST",
          host: TAVILY_HOST,
          path: TAVILY_PATH,
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": String(bodyBytes.length),
            "user-agent": DEFAULT_USER_AGENT,
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

function extractHits(
  parsed: unknown,
): RawProviderResponse["hits"] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const hits: RawProviderResponse["hits"] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      content?: unknown;
    };
    const hit: RawProviderResponse["hits"][number] = {};
    if (typeof e.title === "string") hit.title = e.title;
    if (typeof e.url === "string") hit.url = e.url;
    if (typeof e.content === "string") hit.snippet = e.content;
    hits.push(hit);
  }
  return hits;
}


export const tavilyProvider: SearchProvider = {
  id: "tavily",
  displayName: "Tavily",
  needsApiKey: true,
  envVar: "TAVILY_API_KEY",

  async search(
    query: string,
    maxResults: number,
    auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    if (!auth.apiKey) {
      return {
        status: 0,
        hits: [],
        parseError: "missing api key",
      };
    }

    const clamped = clampMaxResults(maxResults);
    const { status, body } = await dispatchRequest(
      query,
      clamped,
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
        parseError: "missing results array in Tavily response",
      };
    }

    return { status, hits };
  },
};

searchProviders.tavily = tavilyProvider;
