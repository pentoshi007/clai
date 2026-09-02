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
          generation.url.includes(route.urlContains),
        );
        expect(scenarioGenerations).toHaveLength(1);
        const sent = scenarioGenerations[0]!;
        const redacted = {
          url: redactUrl(sent.url),
          method: sent.method,
          headers: redactHeaders(sent.headers),
          body: sent.body,
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
