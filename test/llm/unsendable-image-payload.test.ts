import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLearnedVisionCapabilities,
  registerModelVisionCapability,
} from "../../src/llm/capabilities.js";
import { requestForRoute } from "../../src/llm/routing/attempt-request.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { executeCompactionSummary } from "../../src/agent/compaction-executor.js";
import { pathBackedMessages } from "../../src/app/controllers/session-persistence.js";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import { installTransport } from "../conformance/fake-transport.js";
import {
  buildWireResponse,
  jsonResponse,
} from "../conformance/wire-fixtures.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const provider = "explabs";
const model = "gpt-5.6-luna";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_BASE64 = "/9j/";

const EMPTY_IMAGE_REJECTION = {
  error: {
    message:
      "provider rejected the request: Invalid 'input[0].content[1].image_url'. Expected a data URL with an image MIME type (e.g. 'data:image/png;base64,aW1nIGJ5dGVzIGhlcmU='), but got empty bytes.",
    type: "invalid_request_error",
    param: "input[0].content[1].image_url",
    code: "invalid_request",
  },
};

function countEmptyImagePayloads(node: unknown): number {
  if (typeof node === "string") {
    const dataUrl = /^data:[^;]+;base64,(.*)$/i.exec(node);
    return dataUrl && dataUrl[1]!.length === 0 ? 1 : 0;
  }
  if (Array.isArray(node)) {
    return node.reduce((sum, item) => sum + countEmptyImagePayloads(item), 0);
  }
  if (node && typeof node === "object") {
    return Object.values(node).reduce(
      (sum, value) => sum + countEmptyImagePayloads(value),
      0,
    );
  }
  return 0;
}

function imagePayloadCount(node: unknown): number {
  if (typeof node === "string") {
    return /^data:[^;]+;base64,.+$/i.test(node) ? 1 : 0;
  }
  if (Array.isArray(node)) {
    return node.reduce((sum, item) => sum + imagePayloadCount(item), 0);
  }
  if (node && typeof node === "object") {
    return Object.values(node).reduce(
      (sum, value) => sum + imagePayloadCount(value),
      0,
    );
  }
  return 0;
}

/** A provider that behaves like the reported ones: an empty image payload is a hard 400. */
function installStrictImageTransport() {
  return installTransport((request) => {
    if (countEmptyImagePayloads(request.body) > 0) {
      return jsonResponse(EMPTY_IMAGE_REJECTION, 400);
    }
    const stream =
      Boolean((request.body as { stream?: boolean } | undefined)?.stream) &&
      !request.url.endsWith("/messages");
    return buildWireResponse(
      request.url.endsWith("/responses") ? "meta_responses" : "chat_completions",
      stream ? "stream" : "complete",
      "answer",
      model,
    );
  });
}

function requestWith(images: ChatMessage["images"]): CompletionRequest {
  return {
    provider,
    model,
    messages: [
      { role: "system", content: "Stable rules" },
      { role: "user", content: "look at this screenshot", images },
    ],
  };
}

beforeEach(() => {
  registerModelVisionCapability({ provider, model, vision: true });
});

afterEach(() => {
  clearLearnedVisionCapabilities();
  resetResponsesWireStatesForTesting();
  vi.unstubAllGlobals();
});

describe("unsendable image payloads", () => {
  it("keeps a real image payload untouched on a vision-capable route", () => {
    const request = requestWith([
      { mediaType: "image/png", dataBase64: PNG_BASE64, path: "/tmp/shot.png" },
    ]);
    const routed = requestForRoute(request, provider, model);
    expect(routed).toBe(request);
    expect(routed.messages[1]?.images?.[0]?.dataBase64).toBe(PNG_BASE64);
  });

  it("drops a persisted image projection instead of sending an empty data url", () => {
    const [projection] = pathBackedMessages([
      {
        role: "user",
        content: "look at this screenshot",
        images: [
          { mediaType: "image/png", dataBase64: PNG_BASE64, path: "/tmp/shot.png" },
        ],
      },
    ]);
    expect(projection?.images?.[0]?.dataBase64).toBe("");
    const routed = requestForRoute(requestWith(projection?.images), provider, model);
    expect(routed.messages[1]?.images).toBeUndefined();
    expect(routed.messages[1]?.content).toBe("look at this screenshot");
  });

  it("keeps the usable image of a mixed message", () => {
    const routed = requestForRoute(
      requestWith([
        { mediaType: "image/png", dataBase64: "" },
        { mediaType: "image/png", dataBase64: PNG_BASE64 },
      ]),
      provider,
      model,
    );
    expect(routed.messages[1]?.images?.map((image) => image.dataBase64)).toEqual([
      PNG_BASE64,
    ]);
  });

  it.each([
    ["not base64", "image/png", "not an image at all"],
    ["not the declared type", "image/png", JPEG_BASE64],
    ["decodes to nothing", "image/png", "===="],
  ])("drops a payload that %s", (_case, mediaType, dataBase64) => {
    const routed = requestForRoute(
      requestWith([{ mediaType, dataBase64 }]),
      provider,
      model,
    );
    expect(routed.messages[1]?.images).toBeUndefined();
  });

  async function summarize(history: ChatMessage[]) {
    resetResponsesWireStatesForTesting();
    const transport = installStrictImageTransport();
    const summary = await executeCompactionSummary({
      provider,
      model,
      systemContent: "You compress conversation history into continuation memory.",
      prompt: "Write the continuation memory now.",
      maxTokens: 4096,
      stream: false,
      sourceMessages: history,
      requestSettings: { provider, model },
    });
    return { summary, transport };
  }

  function textOnlyHistory(): ChatMessage[] {
    return [
      { role: "system", content: "Stable rules" },
      { role: "user", content: "look at this screenshot" },
      { role: "assistant", content: "The screenshot showed a failing test." },
      { role: "user", content: "Summarize what we did so far." },
    ];
  }

  function projectedHistory(): ChatMessage[] {
    return pathBackedMessages([
      { role: "system", content: "Stable rules" },
      {
        role: "user",
        content: "look at this screenshot",
        images: [
          { mediaType: "image/png", dataBase64: PNG_BASE64, path: "/tmp/shot.png" },
        ],
      },
      { role: "assistant", content: "The screenshot showed a failing test." },
      { role: "user", content: "Summarize what we did so far." },
    ]);
  }

  it("compacts a session whose history only holds image projections", async () => {
    const plain = await summarize(textOnlyHistory());
    const projected = await summarize(projectedHistory());

    expect(plain.summary).toBe("conformance answer");
    expect(projected.summary).toBe(plain.summary);
    expect(projected.transport.generations).toHaveLength(
      plain.transport.generations.length,
    );
    for (const generation of projected.transport.generations) {
      expect(countEmptyImagePayloads(generation.body)).toBe(0);
    }
  });

  async function replayWith(images: ChatMessage["images"]) {
    resetResponsesWireStatesForTesting();
    const transport = installStrictImageTransport();
    const snapshot = {
      provider,
      model,
      messages: [
        { role: "system" as const, content: "Stable rules" },
        {
          role: "user" as const,
          content: "look at this screenshot",
          images,
        },
      ],
    };
    await executeCompactionSummary({
      provider,
      model,
      systemContent: "You compress conversation history into continuation memory.",
      prompt: "Write the continuation memory now.",
      maxTokens: 4096,
      stream: false,
      baseRequest: snapshot,
      history: snapshot.messages,
    });
    return transport;
  }

  it("replays a captured request tail without forwarding empty image payloads", async () => {
    const transport = await replayWith([
      { mediaType: "image/png", dataBase64: "", path: "/tmp/shot.png" },
    ]);
    expect(transport.generations.length).toBeGreaterThan(0);
    for (const generation of transport.generations) {
      expect(countEmptyImagePayloads(generation.body)).toBe(0);
      expect(imagePayloadCount(generation.body)).toBe(0);
    }
  });

  it("keeps the replayed prefix byte-identical when the payload is real", async () => {
    const transport = await replayWith([
      { mediaType: "image/png", dataBase64: PNG_BASE64, path: "/tmp/shot.png" },
    ]);
    expect(
      transport.generations.some(
        (generation) => imagePayloadCount(generation.body) === 1,
      ),
    ).toBe(true);
    for (const generation of transport.generations) {
      expect(countEmptyImagePayloads(generation.body)).toBe(0);
    }
  });
});
