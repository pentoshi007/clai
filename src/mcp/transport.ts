import type {
  JsonRpcNotification,
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
  | "too-large";

export class McpTransportError extends Error {
  readonly kind: McpTransportFailureKind;
  constructor(kind: McpTransportFailureKind, message: string) {
    super(message);
    this.name = "McpTransportError";
    this.kind = kind;
  }
}

export interface McpTransport {
  readonly kind: "stdio" | "http" | "sse";
  start(options?: McpRequestOptions): Promise<void>;
  request(
    message: JsonRpcRequest,
    options?: McpRequestOptions,
  ): Promise<JsonRpcResponse>;
  notify(message: JsonRpcNotification, options?: McpRequestOptions): Promise<void>;
  close(): Promise<void>;
  sessionId(): string | undefined;
  setProtocolVersion(version: string): void;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof McpTransportError) return error.kind === "cancelled";
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
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
