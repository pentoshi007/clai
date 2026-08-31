
import https from "node:https";
import type { IncomingMessage } from "node:http";

import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./provider.js";


const BRAVE_HOST = "api.search.brave.com";
const BRAVE_PATH = "/res/v1/web/search";

const BRAVE_MIN_COUNT = 1;
const BRAVE_MAX_COUNT = 20;

const DEFAULT_USER_AGENT = "clai-web-search/1.0";

const MAX_RESPONSE_BYTES = 1_048_576;


type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

export function __setBraveHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

function clampCount(count: number): number {
  if (!Number.isFinite(count)) return BRAVE_MIN_COUNT;
  const rounded = Math.trunc(count);
  if (rounded < BRAVE_MIN_COUNT) return BRAVE_MIN_COUNT;
  if (rounded > BRAVE_MAX_COUNT) return BRAVE_MAX_COUNT;
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
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("count", String(count));
  const path = `${BRAVE_PATH}?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const req = httpsRequestFn(
      {
        method: "GET",
        host: BRAVE_HOST,
        path,
        signal,
        headers: {
          accept: "application/json",
          "user-agent": DEFAULT_USER_AGENT,
          "X-Subscription-Token": apiKey,
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

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

function extractHits(
  parsed: unknown,
): RawProviderResponse["hits"] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const web = (parsed as { web?: unknown }).web;
  if (!web || typeof web !== "object") return null;
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const hits: RawProviderResponse["hits"] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
    };
    const hit: RawProviderResponse["hits"][number] = {};
    if (typeof e.title === "string") hit.title = e.title;
    if (typeof e.url === "string") hit.url = e.url;
    if (typeof e.description === "string") hit.snippet = e.description;
    hits.push(hit);
  }
  return hits;
}


export const braveProvider: SearchProvider = {
  id: "brave",
  displayName: "Brave Search",
  needsApiKey: true,
  envVar: "BRAVE_SEARCH_API_KEY",

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

    const count = clampCount(maxResults);
    const { status, body } = await dispatchRequest(
      query,
      count,
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
        parseError: "missing web.results array in Brave response",
      };
    }

    return { status, hits };
  },
};

searchProviders.brave = braveProvider;
