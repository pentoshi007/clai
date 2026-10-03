import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { providers } from "../../src/llm/router.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { CONFORMANCE_ROUTES } from "./routes.js";
import { installFakeTransport } from "./fake-transport.js";
import {
  redactHeaders,
  redactUrl,
  requestForCase,
  REQUEST_CASES,
} from "./request-cases.js";

const VOLATILE_BODY_KEYS = new Set(["installation_id"]);

function redactBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactBody);
  if (!body || typeof body !== "object") return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = VOLATILE_BODY_KEYS.has(key) ? "<generated>" : redactBody(value);
  }
  return out;
}

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serialized request snapshots", () => {
  for (const route of CONFORMANCE_ROUTES) {
    for (const requestCase of REQUEST_CASES) {
      it(`${route.id} / ${requestCase}`, async () => {
        const transport = installFakeTransport({
          family: route.family,
          mode: "complete",
          scenario: "answer",
          model: route.model,
        });
        const provider = providers[route.provider];
        await provider.complete(requestForCase(route, requestCase), route.auth);

        const scenarioGenerations = transport.generations.filter((generation) =>
          generation.url.includes(route.urlContains) &&
          !generation.headers["x-clai-session"]?.startsWith("preflight-"),
        );
        expect(scenarioGenerations).toHaveLength(1);
        const sent = scenarioGenerations[0]!;
        const redacted = {
          url: redactUrl(sent.url),
          method: sent.method,
          headers: redactHeaders(sent.headers),
          body: redactBody(sent.body),
        };
        const serialized = JSON.stringify(redacted);
        for (const secret of [
          "conformance_key",
          "ws-conformance",
          "wk-conformance",
          "sk-conformance",
          "AIzaConformanceKey0000",
        ]) {
          expect(serialized).not.toContain(secret);
        }
        expect(redacted).toMatchSnapshot();
      });
    }
  }
});
