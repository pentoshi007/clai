import { describe, it, expect, vi, afterEach } from "vitest";
import { nvidiaProvider } from "../src/llm/nvidia.js";
import { qwenCloudProvider } from "../src/llm/qwen-cloud.js";
import { mantleProvider } from "../src/llm/aws-mantle.js";
import { warnOnUnknownProviderId } from "../src/llm/capabilities.js";
import type { ChatMessage } from "../src/types.js";

/**
 * LLM-001: the OpenAI-compatible helpers used to derive vision support from the
 * human-readable provider label ("NVIDIA NIM"), which never matches a
 * ProviderId key, so every attached image was silently stripped.
 */

const imageMessages: ChatMessage[] = [
  {
    role: "user",
    content: "what is in this screenshot?",
    images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
  },
];

function stubFetch(): { bodies: string[] } {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/responses")) {
        return new Response("not found", { status: 404 });
      }
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return { bodies };
}

function imagePartCount(body: string): number {
  const parsed = JSON.parse(body) as {
    messages: Array<{ content: unknown }>;
  };
  let count = 0;
  for (const message of parsed.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{
      type?: string;
      image_url?: { url?: string };
    }>) {
      if (part.type !== "image_url") continue;
      if (part.image_url?.url !== "data:image/png;base64,aGVsbG8=") {
        throw new Error(`unexpected image url: ${part.image_url?.url}`);
      }
      count += 1;
    }
  }
  return count;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LLM-001 — vision reaches the wire for label-named providers", () => {
  const cases: Array<{
    name: string;
    provider: typeof nvidiaProvider;
    model: string;
  }> = [
    {
      name: "nvidia",
      provider: nvidiaProvider,
      model: "meta/llama-4-maverick-17b-128e-instruct",
    },
    { name: "qwen-cloud", provider: qwenCloudProvider, model: "qwen-vl-max" },
    { name: "aws-mantle", provider: mantleProvider, model: "meta.llama-4-scout" },
  ];

  for (const testCase of cases) {
    it(`sends image parts on the ${testCase.name} complete body`, async () => {
      const { bodies } = stubFetch();
      await testCase.provider.complete(
        { messages: imageMessages, model: testCase.model },
        { apiKey: "test-key" },
      );
      expect(bodies).toHaveLength(1);
      expect(imagePartCount(bodies[0]!)).toBe(1);
    });
  }
});

describe("LLM-001 — unknown capability keys are rejected", () => {
  it("throws when a display label is passed instead of a ProviderId", () => {
    expect(() => warnOnUnknownProviderId("test", "NVIDIA NIM")).toThrow(
      /not a canonical ProviderId/,
    );
  });

  it("accepts canonical ids", () => {
    expect(() => warnOnUnknownProviderId("test", "nvidia")).not.toThrow();
  });
});
