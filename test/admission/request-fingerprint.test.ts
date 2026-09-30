import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompletionRequest } from "../../src/types.js";
import { fingerprintFinalRequest } from "../../src/llm/request-fingerprint.js";
import {
  generationFetch,
  OperationUsageRecorder,
  runGenerationAttempt,
} from "../../src/llm/operation-usage.js";

function chatBody(messages: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    model: "fixture-model",
    messages,
    stream: false,
    max_tokens: 64,
    tools: [
      {
        type: "function",
        function: {
          name: "fs_read",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  });
}

function historyPrefix(
  fingerprint: NonNullable<ReturnType<typeof fingerprintFinalRequest>>,
  historyItems: number,
) {
  return fingerprint.prefixes.find(
    (prefix) =>
      prefix.section === "history" &&
      prefix.boundary === "history-item" &&
      prefix.historyItems === historyItems,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function referenceDigest(parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function referencePrefixChain(chunks: readonly string[]): string[] {
  const digests: string[] = [];
  let previous: Buffer | undefined;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk, "utf8");
    const digest = referenceDigest([
      "clai.request-fingerprint.prefix.v1\0",
      ...(previous ? [previous] : []),
      `${bytes.length}:`,
      bytes,
    ]);
    digests.push(digest);
    previous = Buffer.from(digest, "hex");
  }
  return digests;
}

describe("privacy-safe final request fingerprints", () => {
  it("matches an independent byte-level reference for multibyte, escaped and brace-heavy bodies", () => {
    const messages = [
      { role: "system", content: "stable \"quoted\" prefix \\ with slashes" },
      { role: "user", content: "日本語 🚀 émoji \u2028 {\"not\":[\"structure\"]}" },
      {
        role: "assistant",
        content: "lone \ud800 surrogate and \\\" escape",
        toolCalls: [{ id: "c1", name: "fs.read", args: { path: "a/b.ts" } }],
      },
      { role: "tool", content: "line1\nline2\t✓", toolCallId: "c1" },
    ];
    const body = chatBody(messages);
    const fingerprint = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      body,
    )!;

    const modelEnd = body.indexOf(',"messages"');
    const itemEnds: number[] = [];
    let cursor = body.indexOf('"messages":[') + '"messages":['.length;
    for (const [index, message] of messages.entries()) {
      cursor += JSON.stringify(message).length + (index === 0 ? 0 : 1);
      itemEnds.push(cursor);
    }
    const chain = referencePrefixChain([
      body.slice(0, modelEnd),
      body.slice(modelEnd, itemEnds[0]!),
      ...itemEnds.slice(1).map((end, index) => body.slice(itemEnds[index]!, end)),
    ]);
    const historyItems = fingerprint.prefixes.filter(
      (prefix) => prefix.boundary === "history-item",
    );

    expect(fingerprint.body).toEqual({
      byteLength: Buffer.byteLength(body),
      sha256: referenceDigest([Buffer.from(body, "utf8")]),
    });
    expect(historyItems.map((prefix) => prefix.historyItems)).toEqual([1, 2, 3, 4]);
    expect(historyItems.map((prefix) => prefix.sha256)).toEqual(chain.slice(1));
    expect(historyItems.map((prefix) => prefix.byteLength)).toEqual(
      itemEnds.map((end) => Buffer.byteLength(body.slice(0, end))),
    );
    expect(fingerprint.prefixes.at(-1)).toMatchObject({
      section: "wire",
      boundary: "wire",
      byteLength: Buffer.byteLength(body),
    });
  });

  it("hashes identical finalized history prefixes equally and changes on one byte", () => {
    const shared = [
      { role: "system", content: "stable system prefix" },
      { role: "user", content: "first user turn" },
    ];
    const base = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody(shared),
    )!;
    const appended = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody([...shared, { role: "assistant", content: "later answer" }]),
    )!;
    const changed = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody([
        shared[0]!,
        { role: "user", content: "first user turN" },
      ]),
    )!;

    expect(base.serializer).toEqual({ id: "chat-completions", version: 1 });
    expect(base.body.byteLength).toBeGreaterThan(0);
    expect(base.sections.map((section) => section.section)).toEqual([
      "settings",
      "history",
      "tools",
    ]);
    expect(historyPrefix(base, 2)).toEqual(historyPrefix(appended, 2));
    expect(historyPrefix(base, 2)?.sha256).not.toBe(
      historyPrefix(changed, 2)?.sha256,
    );
    expect(base.body.sha256).not.toBe(appended.body.sha256);
  });

  it("records only final-wire metadata on an actual generation admission", async () => {
    const prompt = "private prompt text";
    const reasoning = "private reasoning trace";
    const toolArguments = '{"path":"/private/project/secret.txt"}';
    const fileContent = "private file contents";
    const apiKey = "api-key-secret";
    const querySecret = "query-secret";
    const requestUrl = `https://provider.invalid/v1/chat/completions?key=${querySecret}`;
    const body = chatBody([
      { role: "system", content: prompt },
      {
        role: "assistant",
        content: fileContent,
        reasoning_content: reasoning,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "fs_read", arguments: toolArguments },
          },
        ],
      },
    ]);
    const recorder = new OperationUsageRecorder();
    const request: CompletionRequest = { messages: [], attemptUsage: recorder };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));

    await runGenerationAttempt(
      request,
      {
        provider: "nvidia",
        model: "fixture-model",
        mode: "complete",
        reason: "initial",
      },
      async () => {
        await generationFetch(requestUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body,
        });
        return { text: "ok", provider: "nvidia", model: "fixture-model" };
      },
    );

    const snapshot = recorder.snapshot();
    const attempt = snapshot.attempts[0]!;
    const fingerprint = attempt.requestFingerprint!;
    const telemetry = JSON.stringify(snapshot);

    expect(fingerprint).toMatchObject({
      version: 1,
      serializer: { id: "chat-completions", version: 1 },
      body: { byteLength: Buffer.byteLength(body) },
    });
    expect(Object.isFrozen(fingerprint)).toBe(true);
    expect(Object.isFrozen(fingerprint.sections)).toBe(true);
    for (const forbidden of [
      prompt,
      reasoning,
      toolArguments,
      fileContent,
      apiKey,
      querySecret,
      requestUrl,
      "/private/project/secret.txt",
    ]) {
      expect(telemetry).not.toContain(forbidden);
    }
  });
});
