import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { ClientRequest, IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { webFetch } from "../../src/tools/web/fetch.js";
import { decodeContentEncoding } from "../../src/tools/web/content-encoding.js";

function buildHttpsStub(opts: {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}): { httpsRequest: (url: string | URL, options: unknown) => ClientRequest } {
  const httpsRequest = (_url: string | URL, _options: unknown): ClientRequest => {
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        const socket = new EventEmitter() as unknown as {
          getProtocol: () => string;
          getCipher: () => { name: string };
          getPeerCertificate: () => Record<string, unknown>;
          emit: (...a: unknown[]) => void;
        };
        socket.getProtocol = () => "TLSv1.3";
        socket.getCipher = () => ({ name: "TLS_AES_128_GCM_SHA256" });
        socket.getPeerCertificate = () => ({
          subject: { CN: "example.com" },
          issuer: { CN: "Test CA" },
          subjectaltname: "DNS:example.com",
          valid_from: "Jan  1 00:00:00 2024 GMT",
          valid_to: "Jan  1 00:00:00 2030 GMT",
          raw: Buffer.from([1, 2, 3]),
        });
        (req as unknown as { emit: (...a: unknown[]) => void }).emit("socket", socket);
        socket.emit("connect");
        socket.emit("secureConnect");

        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          headers: Record<string, string>;
          resume: () => void;
          destroy: () => void;
        };
        res.statusCode = opts.status;
        res.headers = opts.headers;
        res.resume = () => {};
        res.destroy = () => {};

        (req as unknown as { emit: (...a: unknown[]) => void }).emit("response", res);
        queueMicrotask(() => {
          (res as { emit: (...a: unknown[]) => void }).emit("data", opts.body);
          (res as { emit: (...a: unknown[]) => void }).emit("end");
        });
      });
    };
    return req;
  };
  return { httpsRequest };
}

const dnsLookup = async (): Promise<{ address: string; family: number }> => ({
  address: "93.184.216.34",
  family: 4,
});

const PAGE = "<html><body><h1>Compressed evidence</h1></body></html>";

describe("content-encoding decoding", () => {
  it("leaves an unencoded body untouched", () => {
    const body = Buffer.from(PAGE, "utf8");
    const decoded = decodeContentEncoding(body, undefined);
    expect(decoded.applied).toEqual([]);
    expect(decoded.body).toBe(body);
  });

  it("treats identity as no encoding", () => {
    const body = Buffer.from(PAGE, "utf8");
    expect(decodeContentEncoding(body, "identity").applied).toEqual([]);
  });

  it("inflates gzip", () => {
    const decoded = decodeContentEncoding(gzipSync(Buffer.from(PAGE, "utf8")), "gzip");
    expect(decoded.applied).toEqual(["gzip"]);
    expect(decoded.body.toString("utf8")).toBe(PAGE);
  });

  it("inflates brotli", () => {
    const decoded = decodeContentEncoding(
      brotliCompressSync(Buffer.from(PAGE, "utf8")),
      "br",
    );
    expect(decoded.applied).toEqual(["br"]);
    expect(decoded.body.toString("utf8")).toBe(PAGE);
  });

  it("returns the original bytes when the declared encoding does not apply", () => {
    const body = Buffer.from(PAGE, "utf8");
    const decoded = decodeContentEncoding(body, "gzip");
    expect(decoded.applied).toEqual([]);
    expect(decoded.body.toString("utf8")).toBe(PAGE);
  });

  it("ignores encodings it does not implement", () => {
    const body = Buffer.from(PAGE, "utf8");
    expect(decodeContentEncoding(body, "compress").applied).toEqual([]);
  });
});

describe("web.fetch against a server that ignores accept-encoding: identity", () => {
  it("yields readable text from a gzip response", async () => {
    const { httpsRequest } = buildHttpsStub({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
      },
      body: gzipSync(Buffer.from(PAGE, "utf8")),
    });

    const result = await webFetch(
      { url: "https://example.com/", responseMode: "raw" },
      { core: { httpsRequest, dnsLookup } },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("<h1>Compressed evidence</h1>");
  });
});
