import { vi } from "vitest";

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(buffer: Buffer | Uint8Array, start = 0, end = buffer.length): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buffer[index]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeKiroFrame(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Buffer {
  const encodedHeaders = Object.entries(headers).map(([name, value]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const encoded = Buffer.alloc(4 + nameBytes.length + valueBytes.length);
    encoded.writeUInt8(nameBytes.length, 0);
    nameBytes.copy(encoded, 1);
    encoded.writeUInt8(7, 1 + nameBytes.length);
    encoded.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
    valueBytes.copy(encoded, 4 + nameBytes.length);
    return encoded;
  });
  const headerBytes = Buffer.concat(encodedHeaders);
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 16 + headerBytes.length + payloadBytes.length;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headerBytes.length, 4);
  frame.writeUInt32BE(crc32(frame, 0, 8), 8);
  headerBytes.copy(frame, 12);
  payloadBytes.copy(frame, 12 + headerBytes.length);
  frame.writeUInt32BE(crc32(frame, 0, totalLength - 4), totalLength - 4);
  return frame;
}

export function kiroStreamResponse(frames: readonly Buffer[]): Response {
  const bytes = Buffer.concat(frames);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    },
  );
}

export function kiroCatalogResponse(models: readonly unknown[]): Response {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function isKiroCatalogRequest(input: unknown, init?: RequestInit): boolean {
  return (
    String(input).includes("ListAvailableModels") ||
    new Headers(init?.headers).get("x-amz-target") ===
      "AmazonCodeWhispererService.ListAvailableModels"
  );
}

export function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

export function installKiroFetch(
  handler: (input: unknown, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
