import type {
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  McpRequestOptions,
} from "./types.js";

export type McpTransportFailureKind =
  | "spawn"
  | "timeout"
  | "cancelled"
  | "closed"
  | "protocol"
  | "network"
  | "too-large"
  | "browser";

export class McpTransportError extends Error {
  readonly kind: McpTransportFailureKind;
  readonly status?: number | undefined;
  constructor(kind: McpTransportFailureKind, message: string, status?: number) {
    super(message);
    this.name = "McpTransportError";
    this.kind = kind;
    this.status = status;
  }
}

export interface McpTransportHandlers {
  readonly request: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  readonly notification: (notification: JsonRpcNotification) => void;
}

export async function dispatchServerMessage(
  message: JsonRpcMessage,
  handlers: McpTransportHandlers | undefined,
  respond: (response: JsonRpcResponse) => Promise<void>,
): Promise<void> {
  if (!("method" in message)) return;
  if (!("id" in message)) {
    handlers?.notification(message);
    return;
  }
  const response = handlers
    ? await handlers.request(message)
    : {
        jsonrpc: "2.0" as const,
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported MCP client method: ${message.method}`,
        },
      };
  await respond(response);
}

export interface McpTransport {
  readonly kind: "stdio" | "http" | "sse";
  start(options?: McpRequestOptions): Promise<void>;
  request(message: JsonRpcRequest, options?: McpRequestOptions): Promise<JsonRpcResponse>;
  notify(message: JsonRpcNotification, options?: McpRequestOptions): Promise<void>;
  close(): Promise<void>;
  sessionId(): string | undefined;
  setProtocolVersion(version: string): void;
  setHandlers?(handlers: McpTransportHandlers): void;
  listen?(): void;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof McpTransportError) return error.kind === "cancelled";
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

export async function awaitMcpOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () =>
        reject(
          signal.reason instanceof McpTransportError
            ? signal.reason
            : new McpTransportError("cancelled", "MCP operation cancelled."),
        );
      operation.then(resolve, reject);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  };
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new McpTransportError("timeout", `Request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  return { signal: controller.signal, dispose };
}
