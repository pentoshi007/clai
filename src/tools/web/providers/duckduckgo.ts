
import { Buffer } from "node:buffer";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import * as cheerio from "cheerio/slim";

import type { RawProviderResponse, SearchProvider } from "./provider.js";
import { searchProviders } from "./provider.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

export function __setDuckduckgoHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

const MAX_RESPONSE_BYTES = 1_048_576;

interface FetchedHtml {
  status: number;
  body: string;
}

function httpsGetText(url: string, signal: AbortSignal): Promise<FetchedHtml> {
  return new Promise<FetchedHtml>((resolve, reject) => {
    let req: ClientRequest;
    try {
      req = httpsRequestFn(
        url,
        {
          method: "GET",
          signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "identity",
          },
        },
        (res: IncomingMessage) => {
          const status =
            typeof res.statusCode === "number" ? res.statusCode : 0;
          const chunks: Buffer[] = [];
          let received = 0;
          let stopped = false;

          const stop = (): void => {
            if (stopped) return;
            stopped = true;
            try {
              res.destroy();
            } catch {
            }
          };

          res.on("data", (chunk: Buffer) => {
            if (stopped) return;
            const remaining = MAX_RESPONSE_BYTES - received;
            if (remaining <= 0) {
              stop();
              return;
            }
            if (chunk.byteLength > remaining) {
              chunks.push(chunk.subarray(0, remaining));
              received += remaining;
              stop();
              return;
            }
            chunks.push(chunk);
            received += chunk.byteLength;
          });

          res.once("end", () => {
            const body = Buffer.concat(chunks, received).toString("utf-8");
            resolve({ status, body });
          });

          res.once("close", () => {
            if (stopped) {
              const body = Buffer.concat(chunks, received).toString("utf-8");
              resolve({ status, body });
            }
          });

          res.once("error", (err) => {
            reject(err);
          });
        },
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.once("error", (err: Error) => {
      reject(err);
    });

    req.end();
  });
}

const URL_INVALID_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

function isValidHitUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (URL_INVALID_CHARS_RE.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function unwrapDdgRedirect(href: string): string | undefined {
  if (typeof href !== "string" || href.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(href, ENDPOINT);
  } catch {
    return undefined;
  }
  if (parsed.pathname === "/l/" && parsed.searchParams.has("uddg")) {
    const destination = parsed.searchParams.get("uddg") ?? "";
    if (destination.length === 0) return undefined;
    return destination;
  }
  return parsed.toString();
}

export const duckduckgoProvider: SearchProvider = {
  id: "duckduckgo",
  displayName: "DuckDuckGo",
  needsApiKey: false,
  async search(
    query: string,
    maxResults: number,
    _auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}`;

    const { status, body } = await httpsGetText(url, signal);

    if (status < 200 || status >= 300) {
      return { status, hits: [] };
    }

    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(body);
    } catch (err) {
      return {
        status,
        hits: [],
        parseError: err instanceof Error ? err.message : String(err),
      };
    }

    const hits: Array<{ title?: string; url?: string; snippet?: string }> = [];

    $(".result").each((_idx, el) => {
      if (hits.length >= maxResults) return false;

      const titleAnchor = $(el).find(".result__title a").first();
      const titleText = titleAnchor.text().trim();
      const href = titleAnchor.attr("href") ?? "";
      const destination = unwrapDdgRedirect(href);

      if (destination === undefined || !isValidHitUrl(destination)) return;

      const snippet = $(el).find(".result__snippet").first().text().trim();
      hits.push({ title: titleText, url: destination, snippet });
      return;
    });

    return { status, hits };
  },
};

searchProviders.duckduckgo = duckduckgoProvider;
