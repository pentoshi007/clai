import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { classifyHost } from "../../tools/web/ssrf-guard.js";
import { McpTransportError } from "../transport.js";
import { randomState } from "./pkce.js";
import type { LoopbackAuthorizationResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>clai</title></head>' +
  "<body><p>Authorization complete. You can close this tab and return to clai.</p></body></html>";

function assertBrowserUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpTransportError("protocol", "Refusing to open a browser for an unparseable URL.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    const classification = classifyHost(url.hostname.replace(/^\[|\]$/g, ""));
    if (classification?.class === "loopback") return url;
  }
  throw new McpTransportError(
    "protocol",
    `Refusing to open a browser for scheme "${url.protocol}"; only https or loopback http are allowed.`,
  );
}

export interface OpenBrowserDeps {
  readonly platform?: NodeJS.Platform | undefined;
  readonly spawnImpl?: typeof spawn | undefined;
}

export function systemBrowserAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  return (
    platform === "darwin" ||
    platform === "win32" ||
    Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.TERMUX_VERSION)
  );
}

function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openSystemBrowser(rawUrl: string, deps: OpenBrowserDeps = {}): Promise<void> {
  const url = assertBrowserUrl(rawUrl);
  const platform = deps.platform ?? process.platform;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const { command, args } = browserCommand(platform, url.toString());
  const child = spawnImpl(command, args, {
    stdio: "ignore",
    shell: false,
    detached: false,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), 25);
    if (typeof timer.unref === "function") timer.unref();
    child.on("spawn", () => finish());
    child.on("error", (error) =>
      finish(
        new McpTransportError(
          "browser",
          `Could not launch a browser (${command}): ${error.message}.`,
        ),
      ),
    );
  });
  if (typeof child.unref === "function") child.unref();
}

export interface LoopbackAuthorizationParams {
  buildAuthorizationUrl(redirectUri: string, state: string): string | Promise<string>;
  readonly openBrowser?: ((url: string) => Promise<void>) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly callbackPath?: string | undefined;
  readonly successHtml?: string | undefined;
  readonly onAuthorizationUrl?: ((url: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly readCallbackUrl?:
    | ((info: {
        url: string;
        redirectUri: string;
        signal: AbortSignal;
      }) => Promise<string | undefined>)
    | undefined;
}

type CallbackReading =
  | { readonly kind: "ignore" }
  | { readonly kind: "ok"; readonly code: string }
  | { readonly kind: "error"; readonly reason: string };

function readCallback(
  requestUrl: URL,
  callbackPath: string,
  expectedState: string,
): CallbackReading {
  if (requestUrl.pathname !== callbackPath) return { kind: "ignore" };
  const returnedState = requestUrl.searchParams.get("state");
  if (!returnedState || returnedState !== expectedState) {
    return {
      kind: "error",
      reason: "authorization state did not match the request (possible CSRF)",
    };
  }
  const error = requestUrl.searchParams.get("error");
  if (error)
    return {
      kind: "error",
      reason: `authorization server returned error "${error}"`,
    };
  const code = requestUrl.searchParams.get("code");
  if (!code)
    return {
      kind: "error",
      reason: "authorization response contained no code",
    };
  return { kind: "ok", code };
}

export function runLoopbackAuthorization(
  params: LoopbackAuthorizationParams,
): Promise<LoopbackAuthorizationResult> {
  const host = params.host ?? "127.0.0.1";
  const callbackPath = params.callbackPath ?? "/callback";
  const successHtml = params.successHtml ?? DEFAULT_SUCCESS_HTML;
  const state = randomState();
  return new Promise<LoopbackAuthorizationResult>((resolve, reject) => {
    const server = createServer();
    let redirectUri = "";
    let settled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      finishReject(
        new McpTransportError(
          "timeout",
          "MCP OAuth authorization timed out waiting for the browser callback.",
        ),
      );
    }, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    const close = (): void => {
      clearTimeout(timer);
      server.closeAllConnections?.();
      server.close(() => undefined);
      params.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    };
    function finishResolve(result: LoopbackAuthorizationResult): void {
      if (settled) return;
      settled = true;
      close();
      resolve(result);
    }
    function finishReject(error: Error): void {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    }
    const onAbort = (): void =>
      finishReject(new McpTransportError("cancelled", "MCP OAuth authorization cancelled."));
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    params.signal?.addEventListener("abort", onAbort, { once: true });
    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url ?? "/", redirectUri || `http://${host}`);
      const reading = readCallback(requestUrl, callbackPath, state);
      if (reading.kind === "ignore") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const ok = reading.kind === "ok";
      res.statusCode = ok ? 200 : 400;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        ok ? successHtml : "<!doctype html><html><body><p>Authorization failed.</p></body></html>",
      );
      if (reading.kind === "ok") {
        finishResolve({ code: reading.code, state, redirectUri });
      } else {
        finishReject(new McpTransportError("protocol", `MCP OAuth ${reading.reason}.`));
      }
    });
    server.on("error", (error) => finishReject(error));
    server.listen(params.port ?? 0, host, () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://${host}:${port}${callbackPath}`;
      Promise.resolve()
        .then(() => params.buildAuthorizationUrl(redirectUri, state))
        .then((authUrl) => {
          if (settled) return;
          params.onAuthorizationUrl?.(authUrl);
          if (params.readCallbackUrl) {
            void params
              .readCallbackUrl({
                url: authUrl,
                redirectUri,
                signal: controller.signal,
              })
              .then((callbackUrl) => {
                if (settled) return;
                if (callbackUrl === undefined) {
                  finishReject(
                    new McpTransportError("cancelled", "MCP OAuth authorization cancelled."),
                  );
                  return;
                }
                let callback: URL;
                try {
                  callback = new URL(callbackUrl.trim());
                } catch {
                  throw new McpTransportError(
                    "protocol",
                    "Paste the complete OAuth callback URL, including code and state.",
                  );
                }
                const expected = new URL(redirectUri);
                if (
                  callback.origin !== expected.origin ||
                  callback.pathname !== expected.pathname ||
                  callback.username ||
                  callback.password
                ) {
                  throw new McpTransportError(
                    "protocol",
                    "OAuth callback URL did not match this sign-in request.",
                  );
                }
                const reading = readCallback(callback, callbackPath, state);
                if (reading.kind === "ok")
                  finishResolve({ code: reading.code, state, redirectUri });
                else
                  finishReject(
                    new McpTransportError(
                      "protocol",
                      reading.kind === "error"
                        ? `MCP OAuth ${reading.reason}.`
                        : "OAuth callback URL did not match this sign-in request.",
                    ),
                  );
              })
              .catch((error: unknown) =>
                finishReject(error instanceof Error ? error : new Error(String(error))),
              );
          }
          if (params.openBrowser) {
            return params.openBrowser(authUrl).catch((error: unknown) => {
              if (!params.readCallbackUrl) throw error;
            });
          }
          if (!params.readCallbackUrl)
            throw new McpTransportError(
              "browser",
              "No browser or callback input is available for OAuth sign-in.",
            );
        })
        .catch((error) => finishReject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}
