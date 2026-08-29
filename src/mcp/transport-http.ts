import {
  isJsonRpcResponse,
  parseMessage,
  SseDecoder,
} from "./jsonrpc.js";
import {
  McpTransportError,
  withTimeout,
  type McpTransport,
} from "./transport.js";
import { parseWwwAuthenticate } from "./auth/www-authenticate.js";
import type { McpAuthChallenge, McpAuthProvider } from "./auth/types.js";
import {
  MCP_PROTOCOL_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpHttpConfig,
  type McpRequestOptions,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

function mapFetchError(error: unknown, signal?: AbortSignal): McpTransportError {
  if (error instanceof McpTransportError) return error;
  const reason = signal?.reason;
  if (reason instanceof McpTransportError) return reason;
  const err = error as { name?: string; message?: string; cause?: { message?: string } };
  if (err?.name === "AbortError") {
    return new McpTransportError("cancelled", "MCP HTTP request aborted.");
  }
  const detail = err?.cause?.message ?? err?.message ?? "unknown error";
  return new McpTransportError("network", `MCP HTTP request failed: ${detail}`);
}

function redirectError(response: Response): McpTransportError | undefined {
  const status = response.status;
  const isRedirect = response.type === "opaqueredirect" || (status >= 300 && status < 400);
  if (!isRedirect) return undefined;
  const location = response.headers.get("location") ?? "an undisclosed location";
  return new McpTransportError(
    "protocol",
    `MCP HTTP endpoint attempted a redirect (${status || "opaque"}) to "${location}". Refusing to follow it so credentials cannot cross origin; update the server url to the final endpoint.`,
  );
}

async function rejectRedirect(response: Response): Promise<void> {
  const error = redirectError(response);
  if (!error) return;
  if (response.body) await response.body.cancel().catch(() => undefined);
  throw error;
}

function sseStreamError(server: string, status: number): McpTransportError {
  return new McpTransportError(
    "network",
    status === 401
      ? unauthorizedHint(server)
      : `MCP SSE stream returned ${status}.`,
  );
}

function ssePostError(server: string, status: number): McpTransportError {
  return new McpTransportError(
    "network",
    status === 401
      ? unauthorizedHint(server)
      : `MCP SSE POST returned ${status}.`,
  );
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpTransportError("too-large", "MCP HTTP response exceeded the size limit.");
      }
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

function baseHeaders(
  sessionId: string | undefined,
  protocolVersion: string | undefined,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept,
  };
  if (sessionId) headers[SESSION_HEADER] = sessionId;
  if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;
  return headers;
}

async function collectSseResponse(
  response: Response,
  targetId: JsonRpcRequest["id"],
  maxBytes: number,
): Promise<JsonRpcResponse> {
  const body = response.body;
  if (!body) {
    throw new McpTransportError("protocol", "MCP SSE response had no body.");
  }
  const reader = body.getReader();
  const sse = new SseDecoder();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new McpTransportError("too-large", "MCP SSE stream exceeded the size limit.");
      }
      for (const event of sse.push(value)) {
        const message = parseMessage(event.data);
        if (message && isJsonRpcResponse(message) && String(message.id) === String(targetId)) {
          return message;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new McpTransportError("protocol", "MCP SSE stream closed before a matching response arrived.");
}

export interface HttpTransportOptions {
  readonly requestTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly authProvider?: McpAuthProvider | undefined;
}

function unauthorizedHint(server: string): string {
  return (
    `MCP server ${server} returned 401 Unauthorized. ` +
    "Choose its sign-in row in /mcp, run /mcp login <server>, or fix its auth config."
  );
}

export class StreamableHttpTransport implements McpTransport {
  readonly kind = "http" as const;

  private session: string | undefined;
  private protocolVersion: string = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly config: McpHttpConfig,
    private readonly options: HttpTransportOptions = {},
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get maxBytes(): number {
    return this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  sessionId(): string | undefined {
    return this.session;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  private async resolveHeaders(accept: string): Promise<Record<string, string>> {
    const base = baseHeaders(this.session, this.protocolVersion, accept);
    const authHeaders = this.options.authProvider
      ? await this.options.authProvider.headers()
      : {};
    return {
      ...base,
      ...authHeaders,
      ...this.config.headers,
    };
  }

  private async sendOnce(
    accept: string,
    method: string,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = await this.resolveHeaders(accept);
    const init: RequestInit = { method, headers, redirect: "manual", signal };
    if (body !== undefined) init.body = body;
    return this.fetchImpl(this.config.url, init);
  }

  private async retryOnUnauthorized(
    response: Response,
    resend: () => Promise<Response>,
  ): Promise<Response> {
    const provider = this.options.authProvider;
    if (!provider) return response;
    const challenge: McpAuthChallenge | undefined = parseWwwAuthenticate(
      response.headers.get("www-authenticate"),
    );
    if (response.body) await response.body.cancel().catch(() => undefined);
    const refreshed = await provider.onUnauthorized(challenge);
    if (!refreshed) return response;
    return resend();
  }

  private async failForStatus(response: Response): Promise<never> {
    if (response.status === 401) {
      const detail = await readBoundedText(response, this.maxBytes).catch(() => "");
      throw new McpTransportError(
        "network",
        `${unauthorizedHint(this.config.url)}${detail ? ` Server said: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const detail = await readBoundedText(response, this.maxBytes).catch(() => "");
    throw new McpTransportError(
      "network",
      `MCP HTTP request returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}.`,
    );
  }

  async request(
    message: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    if (this.closed) throw new McpTransportError("closed", "MCP HTTP transport closed.");
    const id = this.nextId++;
    const framed: JsonRpcRequest = { ...message, id };
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    const accept = "application/json, text/event-stream";
    const body = JSON.stringify(framed);
    const resend = (): Promise<Response> => this.sendOnce(accept, "POST", body, signal);
    try {
      let response = await resend();
      this.captureSession(response);
      const redirect = redirectError(response);
      if (redirect) throw redirect;
      if (response.status === 401) {
        response = await this.retryOnUnauthorized(response, resend);
        this.captureSession(response);
        const retryRedirect = redirectError(response);
        if (retryRedirect) throw retryRedirect;
      }
      if (!response.ok) await this.failForStatus(response);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        return await collectSseResponse(response, framed.id, this.maxBytes);
      }
      const text = await readBoundedText(response, this.maxBytes);
      const parsed = parseMessage(text);
      if (!parsed || !isJsonRpcResponse(parsed)) {
        throw new McpTransportError("protocol", "MCP HTTP response was not a JSON-RPC response.");
      }
      return parsed;
    } catch (error) {
      throw mapFetchError(error);
    } finally {
      dispose();
    }
  }

  async notify(
    message: JsonRpcNotification,
    options: McpRequestOptions = {},
  ): Promise<void> {
    if (this.closed) throw new McpTransportError("closed", "MCP HTTP transport closed.");
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    try {
      const response = await this.sendOnce(
        "application/json, text/event-stream",
        "POST",
        JSON.stringify(message),
        signal,
      );
      this.captureSession(response);
      const redirect = redirectError(response);
      if (redirect) throw redirect;
      if (response.body) await response.body.cancel().catch(() => undefined);
    } catch (error) {
      throw mapFetchError(error);
    } finally {
      dispose();
    }
  }

  private captureSession(response: Response): void {
    const id = response.headers.get(SESSION_HEADER);
    if (id && id.length > 0) this.session = id;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.session) return;
    try {
      const { signal, dispose } = withTimeout(undefined, DEFAULT_REQUEST_TIMEOUT_MS);
      try {
        const response = await this.sendOnce("application/json", "DELETE", undefined, signal);
        if (response.body) await response.body.cancel().catch(() => undefined);
      } finally {
        dispose();
      }
    } catch {
      void 0;
    }
  }
}

interface PendingRequest {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  dispose(): void;
}

export class LegacySseTransport implements McpTransport {
  readonly kind = "sse" as const;

  private protocolVersion: string = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private closed = false;
  private endpointUrl: string | undefined;
  private readonly streamController = new AbortController();
  private readonly pending = new Map<number, PendingRequest>();
  private readyPromise: Promise<void> | undefined;
  private pumpError: McpTransportError | undefined;

  constructor(
    private readonly config: McpHttpConfig,
    private readonly options: HttpTransportOptions = {},
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get maxBytes(): number {
    return this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  sessionId(): string | undefined {
    return undefined;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onFail = (error: McpTransportError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this.pump(onReady, onFail).catch((error) => onFail(mapFetchError(error)));
    });
    return this.readyPromise;
  }

  private async streamHeaders(accept: string): Promise<Record<string, string>> {
    const base: Record<string, string> = { accept };
    if (this.protocolVersion) base[PROTOCOL_HEADER] = this.protocolVersion;
    const authHeaders = this.options.authProvider
      ? await this.options.authProvider.headers()
      : {};
    return { ...base, ...authHeaders, ...this.config.headers };
  }

  private async openStream(): Promise<Response> {
    const headers = await this.streamHeaders("text/event-stream");
    return this.fetchImpl(this.config.url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: this.streamController.signal,
    });
  }

  private async openAuthorizedStream(): Promise<Response> {
    let response = await this.openStream();
    await rejectRedirect(response);
    const provider = this.options.authProvider;
    if (response.status !== 401 || !provider) return response;
    const challenge = parseWwwAuthenticate(
      response.headers.get("www-authenticate"),
    );
    if (response.body) await response.body.cancel().catch(() => undefined);
    const refreshed = await provider.onUnauthorized(challenge);
    if (!refreshed) return response;
    response = await this.openStream();
    await rejectRedirect(response);
    return response;
  }

  private async pump(
    onReady: () => void,
    onFail: (error: McpTransportError) => void,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.openAuthorizedStream();
    } catch (error) {
      onFail(mapFetchError(error));
      return;
    }
    if (!response.ok || !response.body) {
      onFail(sseStreamError(this.config.url, response.status));
      return;
    }
    const reader = response.body.getReader();
    const sse = new SseDecoder();
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.maxBytes) {
          throw new McpTransportError("too-large", "MCP SSE stream exceeded the size limit.");
        }
        for (const event of sse.push(value)) {
          this.handleEvent(event.event, event.data, onReady);
        }
      }
      this.failAll(new McpTransportError("closed", "MCP SSE stream closed."));
    } catch (error) {
      const mapped = mapFetchError(error);
      this.pumpError = mapped;
      onFail(mapped);
      this.failAll(mapped);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private handleEvent(event: string, data: string, onReady: () => void): void {
    if (event === "endpoint") {
      try {
        this.endpointUrl = new URL(data, this.config.url).toString();
        onReady();
      } catch {
        void 0;
      }
      return;
    }
    const message = parseMessage(data);
    if (!message || !isJsonRpcResponse(message)) return;
    const numericId = typeof message.id === "number" ? message.id : Number(message.id);
    if (!Number.isFinite(numericId)) return;
    const entry = this.pending.get(numericId);
    if (!entry) return;
    this.pending.delete(numericId);
    entry.dispose();
    entry.resolve(message);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.dispose();
      entry.reject(error);
    }
    this.pending.clear();
  }

  private async postHeaders(): Promise<Record<string, string>> {
    const base: Record<string, string> = { "content-type": "application/json" };
    if (this.protocolVersion) base[PROTOCOL_HEADER] = this.protocolVersion;
    const authHeaders = this.options.authProvider
      ? await this.options.authProvider.headers()
      : {};
    return { ...base, ...authHeaders, ...this.config.headers };
  }

  private async sendPost(
    endpoint: string,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = await this.postHeaders();
    return this.fetchImpl(endpoint, {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "manual",
    });
  }

  private async retryPostUnauthorized(
    response: Response,
    resend: () => Promise<Response>,
  ): Promise<Response> {
    const provider = this.options.authProvider;
    if (response.status !== 401 || !provider) return response;
    const challenge = parseWwwAuthenticate(
      response.headers.get("www-authenticate"),
    );
    if (response.body) await response.body.cancel().catch(() => undefined);
    const refreshed = await provider.onUnauthorized(challenge);
    if (!refreshed) return response;
    const retried = await resend();
    await rejectRedirect(retried);
    return retried;
  }

  private async postMessage(body: string, signal: AbortSignal): Promise<void> {
    if (!this.endpointUrl) {
      throw new McpTransportError("protocol", "MCP SSE endpoint was never announced.");
    }
    const endpoint = this.endpointUrl;
    const resend = (): Promise<Response> => this.sendPost(endpoint, body, signal);
    let response = await resend();
    await rejectRedirect(response);
    response = await this.retryPostUnauthorized(response, resend);
    if (response.body) await response.body.cancel().catch(() => undefined);
    if (!response.ok) throw ssePostError(endpoint, response.status);
  }

  async request(
    message: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    if (this.closed) throw new McpTransportError("closed", "MCP SSE transport closed.");
    await this.start();
    if (this.pumpError) throw this.pumpError;
    const id = this.nextId++;
    const framed: JsonRpcRequest = { ...message, id };
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    return await new Promise<JsonRpcResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.dispose();
        }
        const reason = signal.reason;
        reject(
          reason instanceof McpTransportError
            ? reason
            : new McpTransportError("cancelled", "MCP request cancelled."),
        );
      };
      const disposeEntry = (): void => {
        dispose();
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        disposeEntry();
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, dispose: disposeEntry });
      this.postMessage(JSON.stringify(framed), signal).catch((error) => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.dispose();
        }
        reject(mapFetchError(error));
      });
    });
  }

  async notify(
    message: JsonRpcNotification,
    options: McpRequestOptions = {},
  ): Promise<void> {
    if (this.closed) throw new McpTransportError("closed", "MCP SSE transport closed.");
    await this.start();
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    try {
      await this.postMessage(JSON.stringify(message), signal);
    } finally {
      dispose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new McpTransportError("closed", "MCP SSE transport closed."));
    try {
      this.streamController.abort();
    } catch {
      void 0;
    }
  }
}
