import { describe, expect, it } from "vitest";
import {
  JsonRpcError,
  LineDecoder,
  SseDecoder,
  createNotification,
  createRequest,
  encodeLine,
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcSuccess,
  parseMessage,
  resultOrThrow,
} from "../../src/mcp/jsonrpc.js";
import type { JsonRpcResponse } from "../../src/mcp/types.js";

describe("json-rpc framing", () => {
  it("creates requests and omits params when absent", () => {
    expect(createRequest(1, "ping")).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(createRequest(2, "tools/call", { name: "x" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "x" },
    });
  });

  it("creates notifications without an id", () => {
    const note = createNotification("notifications/initialized");
    expect(note).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(isJsonRpcNotification(note)).toBe(true);
    expect(isJsonRpcRequest(note)).toBe(false);
  });

  it("encodes a single line terminated by newline", () => {
    const line = encodeLine(createRequest(1, "ping"));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  it("classifies success and failure responses", () => {
    const ok = { jsonrpc: "2.0", id: 1, result: { value: 1 } };
    const bad = { jsonrpc: "2.0", id: 2, error: { code: -1, message: "nope" } };
    expect(isJsonRpcResponse(ok)).toBe(true);
    expect(isJsonRpcResponse(bad)).toBe(true);
    expect(isJsonRpcSuccess(ok as JsonRpcResponse)).toBe(true);
    expect(isJsonRpcFailure(bad as JsonRpcResponse)).toBe(true);
  });

  it("throws JsonRpcError from a failure response", () => {
    const failure = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } } as JsonRpcResponse;
    expect(() => resultOrThrow(failure)).toThrowError(JsonRpcError);
    try {
      resultOrThrow(failure);
    } catch (error) {
      expect((error as JsonRpcError).code).toBe(-32000);
    }
  });

  it("rejects non-json-rpc payloads on parse", () => {
    expect(parseMessage("not json")).toBeUndefined();
    expect(parseMessage(JSON.stringify({ hello: "world" }))).toBeUndefined();
    expect(parseMessage("")).toBeUndefined();
  });
});

describe("LineDecoder", () => {
  it("splits ndjson across chunk boundaries and drops blank lines", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b":2')).toEqual(['{"a":1}']);
    expect(decoder.push("}\n\n")).toEqual(['{"b":2}']);
    expect(decoder.flush()).toEqual([]);
  });

  it("strips trailing carriage returns", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("returns leftover buffer on flush", () => {
    const decoder = new LineDecoder();
    decoder.push('{"partial":true}');
    expect(decoder.flush()).toEqual(['{"partial":true}']);
  });
});

describe("SseDecoder", () => {
  it("parses event and multi-line data blocks", () => {
    const decoder = new SseDecoder();
    const events = decoder.push("event: message\ndata: line1\ndata: line2\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "message", data: "line1\nline2" });
  });

  it("defaults the event name to message and honors ids", () => {
    const decoder = new SseDecoder();
    const events = decoder.push("id: 7\ndata: hello\n\n");
    expect(events[0]).toEqual({ event: "message", data: "hello", id: "7" });
  });

  it("handles endpoint events and crlf boundaries", () => {
    const decoder = new SseDecoder();
    const events = decoder.push("event: endpoint\r\ndata: /messages?s=1\r\n\r\n");
    expect(events[0]).toEqual({ event: "endpoint", data: "/messages?s=1" });
  });

  it("ignores comment lines and buffers partial blocks", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(": keep-alive\ndata: part")).toEqual([]);
    const events = decoder.push("ial\n\n");
    expect(events[0]).toEqual({ event: "message", data: "partial" });
  });
});
