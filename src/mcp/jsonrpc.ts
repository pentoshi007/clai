import type {
  JsonRpcErrorPayload,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
} from "./types.js";
import { McpTransportError } from "./transport.js";

export const MCP_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = "JsonRpcError";
    this.code = payload.code;
    this.data = payload.data;
  }
}

export function createRequest(
  id: JsonRpcId,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function createNotification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };
}

export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

export function encodeLine(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return false;
  if (!("id" in record)) return false;
  return "result" in record || "error" in record;
}

export function isJsonRpcSuccess(value: JsonRpcResponse): value is JsonRpcSuccess {
  return "result" in value;
}

export function isJsonRpcFailure(value: JsonRpcResponse): value is JsonRpcFailure {
  return "error" in value;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && typeof record.method === "string" && "id" in record;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    !("id" in record)
  );
}

export function parseMessage(line: string): JsonRpcMessage | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    isJsonRpcResponse(parsed) ||
    isJsonRpcRequest(parsed) ||
    isJsonRpcNotification(parsed)
  ) {
    return parsed;
  }
  return undefined;
}

export function resultOrThrow(response: JsonRpcResponse): unknown {
  if (isJsonRpcFailure(response)) throw new JsonRpcError(response.error);
  return response.result;
}

export class LineDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly maxBytes: number;

  constructor(maxBytes: number = MCP_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes > 0 ? maxBytes : MCP_MAX_FRAME_BYTES;
  }

  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      throw new McpTransportError(
        "too-large",
        `MCP message exceeded the ${this.maxBytes}-byte line framing limit before a newline arrived.`,
      );
    }
    return lines;
  }

  flush(): string[] {
    const remaining = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    return remaining.length > 0 ? [remaining] : [];
  }
}

export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string | undefined;
}

export class SseDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly maxBytes: number;

  constructor(maxBytes: number = MCP_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes > 0 ? maxBytes : MCP_MAX_FRAME_BYTES;
  }

  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const events: SseEvent[] = [];
    let boundary = this.nextBoundary();
    while (boundary) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const parsed = this.parseBlock(block);
      if (parsed) events.push(parsed);
      boundary = this.nextBoundary();
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      throw new McpTransportError(
        "too-large",
        `MCP SSE event exceeded the ${this.maxBytes}-byte framing limit before a boundary arrived.`,
      );
    }
    return events;
  }

  private nextBoundary(): { index: number; length: number } | undefined {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return undefined;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) {
      return { index: crlf, length: 4 };
    }
    return { index: lf, length: 2 };
  }

  private parseBlock(block: string): SseEvent | undefined {
    let event = "message";
    const dataLines: string[] = [];
    let id: string | undefined;
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.length === 0 || rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? "" : rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
    }
    if (dataLines.length === 0) return undefined;
    return id === undefined
      ? { event, data: dataLines.join("\n") }
      : { event, data: dataLines.join("\n"), id };
  }
}
