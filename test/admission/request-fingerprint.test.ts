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

describe("privacy-safe final request fingerprints", () => {
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
