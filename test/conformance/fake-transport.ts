import { vi } from "vitest";

import {
  buildWireResponse,
  jsonResponse,
  type ConformanceScenario,
  type WireFamily,
  type WireMode,
} from "./wire-fixtures.js";

const GENERATION_MARKERS = [
  "/chat/completions",
  "/messages",
  ":generateContent",
  ":streamGenerateContent",
  "/responses",
  "/api/chat",
];

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface FakeTransport {
  readonly generations: RecordedRequest[];
  readonly all: RecordedRequest[];
}

function isGeneration(url: string): boolean {
  return GENERATION_MARKERS.some((marker) => url.includes(marker));
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return Object.fromEntries(
    Object.entries(raw as Record<string, string>).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

function parseBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function installFakeTransport(options: {
  family: WireFamily;
  mode: WireMode;
  scenario: ConformanceScenario;
  model: string;
}): FakeTransport {
  return installTransport(() =>
    buildWireResponse(options.family, options.mode, options.scenario, options.model),
  );
}

export function isResponsesProbe(url: string): boolean {
  return url.endsWith("/responses");
}

export function installTransport(
  respond: (request: RecordedRequest) => Response,
): FakeTransport {
  const transport: FakeTransport = { generations: [], all: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String((input as { url?: string }).url ?? input);
      const record: RecordedRequest = {
        url,
        method: init?.method ?? "GET",
        headers: headerRecord(init),
        body: parseBody(init),
      };
      transport.all.push(record);
      if (!isGeneration(url)) {
        return jsonResponse({ data: [], models: [] });
      }
      transport.generations.push(record);
      return respond(record);
    }),
  );
  return transport;
}
