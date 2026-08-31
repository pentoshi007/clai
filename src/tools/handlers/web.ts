import { httpFetch } from "../http.js";
import { webFetch } from "../web/fetch.js";
import { webSearch } from "../web/search.js";
import { SEARCH_TIMEOUT_MS } from "../web/types.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
} from "../../agent/message-slim.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
} from "./args.js";
import { extractResultUrls } from "../registry.js";

export const toolRegistry_WEB: Record<string, ToolHandler> = {
  async "http.fetch"(args, options) {
    const headers =
      args.headers &&
      typeof args.headers === "object" &&
      !Array.isArray(args.headers)
        ? (args.headers as Record<string, string>)
        : undefined;
    const url = requireString(args, "url");
    const method = (optionalString(args, "method") ?? "GET").toUpperCase();
    let iOwnThis = args.iOwnThis === true || args.own === true;
    if (!iOwnThis && (method === "GET" || method === "HEAD")) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "::1" ||
          host === "localhost.localdomain" ||
          host === "ip6-localhost" ||
          /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        ) {
          iOwnThis = true;
        }
      } catch {
      }
    }
    const insecureTls =
      args.insecureTls === true ||
      args.tlsInsecure === true ||
      args.insecure === true;
    return httpFetch(url, {
      method: optionalString(args, "method"),
      body: optionalString(args, "body"),
      headers,
      maxBytes: optionalNumber(args, "maxBytes"),
      iOwnThis,
      retries: optionalNumber(args, "retries"),
      timeoutMs: optionalNumber(args, "timeoutMs"),
      responseMode:
        optionalString(args, "responseMode") === "readable"
          ? "readable"
          : "raw",
      responsePart: (() => {
        const part = optionalString(args, "responsePart");
        return part === "headers" || part === "body" ? part : "full";
      })(),
      topLines: optionalNumber(args, "topLines"),
      bottomLines: optionalNumber(args, "bottomLines"),
      maxOutputBytes: optionalNumber(args, "maxOutputBytes"),
      forwardSensitiveHeaders:
        optionalBoolean(args, "forwardSensitiveHeaders") ?? false,
      insecureTls,
      signal: options?.signal,
      authorizeHop: iOwnThis ? undefined : options?.authorizeNetworkHop,
    });
  },
  async "web.search"(args, options) {
    const query = requireString(args, "query");
    const maxResults = optionalNumber(args, "maxResults");
    const selectedTimeoutMs =
      optionalNumber(args, "timeoutMs") ?? SEARCH_TIMEOUT_MS;
    const deadline = Date.now() + selectedTimeoutMs;
    const remainingMs = (): number => Math.max(0, deadline - Date.now());
    const result = await webSearch(
      {
        query,
        ...(maxResults !== undefined ? { maxResults } : {}),
      },
      {
        ...(options?.signal ? { signal: options.signal } : {}),
        timeoutMs: Math.max(1, remainingMs()),
      },
    );

    const fetchTop = optionalNumber(args, "fetchTop");
    const want = fetchTop ? Math.max(0, Math.min(3, Math.floor(fetchTop))) : 0;
    if (!result.ok || want === 0) return result;

    const urls = extractResultUrls(result.output).slice(0, want);
    if (urls.length === 0) return result;
    if (remainingMs() <= 0) {
      return {
        ...result,
        output: `${result.output}\n\n(fetchTop skipped: web.search deadline exhausted)`,
      };
    }

    if (options?.signal?.aborted) {
      return {
        ...result,
        ok: false,
        output: `${result.output}\n\n(aborted before fetchTop)`,
        exitCode: 130,
      };
    }
    options?.onOutput?.(
      `fetchTop: reading ${urls.length} page(s)…\n`,
      "stdout",
    );

    const pages = await Promise.all(
      urls.map(async (url, i) => {
        if (options?.signal?.aborted) {
          return `── PAGE: ${url} (aborted)`;
        }
        options?.onOutput?.(
          `fetchTop [${i + 1}/${urls.length}]: ${url}\n`,
          "stdout",
        );
        try {
          const pageBudgetMs = remainingMs();
          if (pageBudgetMs <= 0) {
            return `── PAGE: ${url} (skipped: web.search deadline exhausted)`;
          }
          const page = await webFetch(
            {
              url,
              responseMode: "readable",
              includeHeaders: false,
              timeoutMs: pageBudgetMs,
            },
            { ...(options?.signal ? { signal: options.signal } : {}) },
          );
          const text = page.output.trim();
          return `── PAGE: ${url} ${page.ok ? "" : "(fetch failed)"}\n${text}`;
        } catch (error) {
          return `── PAGE: ${url} (fetch error: ${error instanceof Error ? error.message : String(error)})`;
        }
      }),
    );

    return {
      ...result,
      output: `${result.output}\n\n${pages.join("\n\n")}`,
    };
  },
  async "web.fetch"(args, options) {
    const url = requireString(args, "url");
    const fetchArgs: Parameters<typeof webFetch>[0] = { url };
    const maxBytes = optionalNumber(args, "maxBytes");
    if (maxBytes !== undefined) fetchArgs.maxBytes = maxBytes;
    const timeoutMs = optionalNumber(args, "timeoutMs");
    if (timeoutMs !== undefined) fetchArgs.timeoutMs = timeoutMs;
    const includeHeaders = optionalBoolean(args, "includeHeaders");
    fetchArgs.includeHeaders = includeHeaders ?? false;
    const includeTls = optionalBoolean(args, "includeTls");
    fetchArgs.includeTls = includeTls ?? false;
    const includeTiming = optionalBoolean(args, "includeTiming");
    fetchArgs.includeTiming = includeTiming ?? false;
    const includeRedirectChain = optionalBoolean(args, "includeRedirectChain");
    fetchArgs.includeRedirectChain = includeRedirectChain ?? false;
    const responseMode = optionalResponseMode(args, "responseMode");
    if (responseMode !== undefined) fetchArgs.responseMode = responseMode;
    const responsePart = optionalString(args, "responsePart");
    if (
      responsePart === "full" ||
      responsePart === "headers" ||
      responsePart === "body"
    ) {
      fetchArgs.responsePart = responsePart;
      if (responsePart === "headers") fetchArgs.includeHeaders = true;
    }
    const topLines = optionalNumber(args, "topLines");
    if (topLines !== undefined) fetchArgs.topLines = topLines;
    const bottomLines = optionalNumber(args, "bottomLines");
    if (bottomLines !== undefined) fetchArgs.bottomLines = bottomLines;
    const maxOutputBytes = optionalNumber(args, "maxOutputBytes");
    if (maxOutputBytes !== undefined) fetchArgs.maxOutputBytes = maxOutputBytes;
    const redactSensitive = optionalBoolean(args, "redactSensitive");
    if (redactSensitive !== undefined)
      fetchArgs.redactSensitive = redactSensitive;
    return webFetch(fetchArgs, {
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
};
