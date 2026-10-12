import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatMessage } from "../../src/types.js";

const DATA_ENV_KEYS = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
] as const;

const ANTHROPIC_SIGNATURE = "anthropic_signature_placeholder_00";
const META_ENCRYPTED = "meta_encrypted_reasoning_placeholder_00";
const GEMINI_SIGNATURE = "gemini_thought_signature_placeholder_00";
const PLAINTEXT_REASONING = "the tool result must be checked first";

let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let originalDataEnv: Partial<Record<(typeof DATA_ENV_KEYS)[number], string | undefined>>;
let homeDir: string;
let configDir: string;
let dataDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  originalDataEnv = {};
  for (const key of DATA_ENV_KEYS) originalDataEnv[key] = process.env[key];
  homeDir = mkdtempSync(join(tmpdir(), "clai-replay-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-replay-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "clai-replay-data-"));
  process.env.HOME = homeDir;
  process.env.CLAI_CONFIG_DIR = configDir;
  process.env.CLAI_DATA_DIR = dataDir;
  for (const key of DATA_ENV_KEYS) {
    if (key !== "CLAI_DATA_DIR") delete process.env[key];
  }
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  for (const key of DATA_ENV_KEYS) {
    const value = originalDataEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  vi.resetModules();
});

function artifactMessages(): ChatMessage[] {
  return [
    { role: "system", content: "stable system prefix" },
    { role: "user", content: "inspect the example file" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_persist_1",
          name: "fs.read",
          args: { path: "docs/example.md" },
          rawArguments: '{"path":"docs/example.md"}',
          thoughtSignature: GEMINI_SIGNATURE,
        },
      ],
      reasoningBlock: {
        text: PLAINTEXT_REASONING,
        signature: ANTHROPIC_SIGNATURE,
        items: [
          {
            type: "reasoning",
            id: "rs_persist_1",
            summary: [{ type: "summary_text", text: PLAINTEXT_REASONING }],
            encrypted_content: META_ENCRYPTED,
          },
        ],
      },
    },
    {
      role: "tool",
      content: "example file contents",
      toolCallId: "call_persist_1",
      name: "fs.read",
      ok: true,
    },
    { role: "user", content: "now summarize it" },
  ];
}

async function saveThenReload(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const { upsertSession } = await import("../../src/store/history.js");
  await upsertSession("replay-session", messages);
  vi.resetModules();
  const { getSession } = await import("../../src/store/history.js");
  const record = await getSession("replay-session");
  expect(record).toBeDefined();
  return record!.messages;
}

describe("artifact persistence and resume", () => {
  it("preserves opaque ChatGPT reasoning while redacting visible replay content", async () => {
    const { createReasoningArtifact, createReasoningArtifactProvenance } = await import("../../src/llm/reasoning-artifacts.js");
    const model = "gpt-6.1-sol";
    const encrypted = "gAAAA_fixture-gsk_random_ciphertext-sk-random_ciphertext-AIzaRandomCiphertext";
    const reasoning = { type: "reasoning", id: "rs_codex", summary: [], encrypted_content: encrypted };
    const message: ChatMessage = {
      role: "assistant",
      content: "Credential sk-visible-secret",
      reasoningArtifacts: [createReasoningArtifact({
        kind: "encrypted", raw: reasoning,
        provenance: createReasoningArtifactProvenance({ provider: "codex", model, dialect: "openai-compatible" }),
        replay: { scope: "all-history", persistence: "all-turns" },
      })],
      responsesReplay: { provider: "codex", model, items: [reasoning, {
        type: "message", id: "msg_codex", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "Credential sk-visible-secret" }],
      }] },
    };
    const [restored] = await saveThenReload([message]);
    expect(restored!.responsesReplay!.items[0]).toEqual(reasoning);
    expect(restored!.content).toBe("Credential sk-••••••");
    expect(JSON.stringify(restored!.responsesReplay!.items[1])).not.toContain("sk-visible-secret");
    const { responsesReplayItems } = await import("../../src/llm/responses-replay.js");
    expect(responsesReplayItems(restored!, "codex", model)?.[0]).toEqual(reasoning);
    expect(message.responsesReplay!.items[1]).toMatchObject({ content: [{ text: "Credential sk-visible-secret" }] });
  });

  it("repairs previously redacted ChatGPT replay from intact persisted artifacts on reload", async () => {
    const { createReasoningArtifact, createReasoningArtifactProvenance } = await import("../../src/llm/reasoning-artifacts.js");
    const model = "gpt-6.1-sol";
    const reasoning = { type: "reasoning", id: "rs_legacy", summary: [], encrypted_content: "gAAAA_gsk_ciphertext" };
    const messages: ChatMessage[] = [{
      role: "assistant", content: "Verified",
      reasoningArtifacts: [createReasoningArtifact({
        kind: "encrypted", raw: reasoning,
        provenance: createReasoningArtifactProvenance({ provider: "codex", model, dialect: "openai-compatible" }),
        replay: { scope: "all-history", persistence: "all-turns" },
      })],
      responsesReplay: { provider: "codex", model, items: [
        { ...reasoning, encrypted_content: "gAAAA_gsk_••••••" },
        { type: "message", id: "msg_legacy", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Verified" }] },
      ] },
    }];
    const { hydrateHistoryRecord } = await import("../../src/store/history/recovery.js");
    const record = hydrateHistoryRecord({ id: "legacy-codex", createdAt: "2026-10-01", updatedAt: "2026-10-01", cwd: "/fixture", messages });
    expect(record.messages[0]!.responsesReplay!.items[0]).toEqual(reasoning);
    const [restored] = await saveThenReload(record.messages);
    const { codexConfigFor } = await import("../../src/llm/codex-config.js");
    const { buildResponsesRequestBody } = await import("../../src/llm/responses-http.js");
    const body = JSON.parse(buildResponsesRequestBody(codexConfigFor({ accessToken: "fixture", accountId: "fixture" }), { messages: [restored!, { role: "user", content: "Continue" }], thinking: { enabled: true, effort: "max" } }, model, true));
    expect(body.input[0]).toEqual(reasoning);
    expect(body.input[1]).toMatchObject({ id: "msg_legacy", phase: "final_answer" });
    expect(body.reasoning.effort).toBe("max");
    expect(messages[0]!.responsesReplay!.items[0]!.encrypted_content).toBe("gAAAA_gsk_••••••");
  });

  it("keeps signed, encrypted, and signature replay fields byte-identical", async () => {
    const reloaded = await saveThenReload(artifactMessages());

    const assistant = reloaded.find((message) => message.toolCalls?.length);
    expect(assistant).toBeDefined();
    expect(assistant!.reasoningBlock?.signature).toBe(ANTHROPIC_SIGNATURE);
    expect(assistant!.reasoningBlock?.text).toBe(PLAINTEXT_REASONING);
    expect(assistant!.reasoningBlock?.items).toEqual([
      {
        type: "reasoning",
        id: "rs_persist_1",
        summary: [{ type: "summary_text", text: PLAINTEXT_REASONING }],
        encrypted_content: META_ENCRYPTED,
      },
    ]);
    expect(assistant!.toolCalls?.[0]?.thoughtSignature).toBe(GEMINI_SIGNATURE);
    expect(assistant!.toolCalls?.[0]?.rawArguments).toBe(
      '{"path":"docs/example.md"}',
    );
  });

  it("does not discard unknown persisted message fields", async () => {
    const messages = artifactMessages();
    const withUnknown = messages.map((message) =>
      message.toolCalls?.length
        ? ({
            ...message,
            providerExtra: { reasoning_details: [{ type: "opaque", data: "d1" }] },
          } as ChatMessage)
        : message,
    );

    const reloaded = await saveThenReload(withUnknown);
    const assistant = reloaded.find((message) => message.toolCalls?.length) as
      | (ChatMessage & { providerExtra?: unknown })
      | undefined;
    expect(assistant?.providerExtra).toEqual({
      reasoning_details: [{ type: "opaque", data: "d1" }],
    });
  });

  it("hydrates persisted legacy reasoning into immutable canonical artifacts", async () => {
    const reloaded = await saveThenReload(artifactMessages());
    const assistant = reloaded.find((message) => message.toolCalls?.length);
    const artifacts = assistant?.reasoningArtifacts ?? [];

    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "signed",
      "encrypted",
      "thought-signature",
    ]);
    expect(artifacts.find((artifact) => artifact.kind === "signed")?.raw).toEqual({
      thinking: PLAINTEXT_REASONING,
      signature: ANTHROPIC_SIGNATURE,
    });
    expect(
      artifacts.find((artifact) => artifact.kind === "encrypted")?.raw,
    ).toEqual({
      items: [
        {
          type: "reasoning",
          id: "rs_persist_1",
          summary: [{ type: "summary_text", text: PLAINTEXT_REASONING }],
          encrypted_content: META_ENCRYPTED,
        },
      ],
    });
    expect(Object.isFrozen(artifacts[0]?.raw)).toBe(true);
  });

  it("round-trips canonical raw artifacts without normalizing provider fields", async () => {
    const { createReasoningArtifact, createReasoningArtifactProvenance } = await import(
      "../../src/llm/reasoning-artifacts.js"
    );
    const raw = {
      type: "reasoning",
      id: "canonical-meta-item",
      encrypted_content: "canonical-encrypted-payload",
      summary: [{ type: "summary_text", text: "synthetic summary" }],
      provider_extra: { nested: ["unchanged", { value: 7 }] },
    };
    const artifact = createReasoningArtifact({
      kind: "encrypted",
      raw,
      provenance: createReasoningArtifactProvenance({
        provider: "meta",
        model: "meta-synthetic",
        dialect: "meta-responses",
        endpoint: "https://synthetic.meta.example/v1",
      }),
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: {
        sequence: 4,
        placement: "before-tool-call",
        toolCallIndex: 0,
      },
    });
    const messages = artifactMessages().map((message) =>
      message.toolCalls?.length
        ? { ...message, reasoningArtifacts: [artifact] }
        : message,
    );

    const reloaded = await saveThenReload(messages);
    const assistant = reloaded.find((message) => message.toolCalls?.length);
    const reloadedArtifact = assistant?.reasoningArtifacts?.[0];
    expect(reloadedArtifact?.raw).toEqual(raw);
    expect(reloadedArtifact?.position).toEqual({
      sequence: 4,
      placement: "before-tool-call",
      toolCallIndex: 0,
    });
    expect(Object.isFrozen(reloadedArtifact?.raw)).toBe(true);
    expect(
      Object.isFrozen(
        (reloadedArtifact?.raw as { provider_extra?: unknown }).provider_extra,
      ),
    ).toBe(true);
  });

  it("replays the artifact to the same route and never to an incompatible one", async () => {
    const reloaded = await saveThenReload(artifactMessages());

    const { providers } = await import("../../src/llm/router.js");
    const { installFakeTransport } = await import("./fake-transport.js");

    const send = async (
      provider: "anthropic" | "nvidia",
      family: "anthropic_messages" | "chat_completions",
      auth: { apiKey: string },
      model: string,
    ): Promise<string> => {
      const transport = installFakeTransport({
        family,
        mode: "complete",
        scenario: "answer",
        model,
      });
      await providers[provider].complete(
        {
          provider,
          model,
          messages: reloaded,
          maxTokens: 256,
          thinking: { enabled: true, effort: "low" },
        },
        auth,
      );
      return JSON.stringify(transport.generations[0]?.body ?? {});
    };

    const anthropicBody = await send(
      "anthropic",
      "anthropic_messages",
      { apiKey: "sk-ant-conformance" },
      "claude-3-5-haiku-latest",
    );
    expect(anthropicBody).toContain(ANTHROPIC_SIGNATURE);
    expect(anthropicBody).not.toContain(GEMINI_SIGNATURE);
    expect(anthropicBody).not.toContain(META_ENCRYPTED);

    vi.unstubAllGlobals();

    const compatibleBody = await send(
      "nvidia",
      "chat_completions",
      { apiKey: "gsk_conformance_key" },
      "llama-3.3-70b-versatile",
    );
    expect(compatibleBody).not.toContain(ANTHROPIC_SIGNATURE);
    expect(compatibleBody).not.toContain(META_ENCRYPTED);
    expect(compatibleBody).not.toContain(GEMINI_SIGNATURE);
    expect(compatibleBody).not.toContain(PLAINTEXT_REASONING);
  });
});
