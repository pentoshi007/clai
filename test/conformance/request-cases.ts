import type { ChatMessage, CompletionRequest, ToolDefinition } from "../../src/types.js";
import type { ConformanceRoute } from "./routes.js";

export type RequestCase =
  | "minimal"
  | "tools"
  | "images"
  | "reasoning-control"
  | "tool-loop-replay"
  | "tool-loop-replay-unsigned";

export const REQUEST_CASES: readonly RequestCase[] = [
  "minimal",
  "tools",
  "images",
  "reasoning-control",
  "tool-loop-replay",
  "tool-loop-replay-unsigned",
];

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

export const SNAPSHOT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "fs.read",
    wireName: "fs_read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    },
    readOnly: true,
  },
  {
    name: "shell.run",
    wireName: "shell_run",
    description: "run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    mutates: true,
  },
];

const STABLE_PREFIX: ChatMessage[] = [
  { role: "system", content: "stable system prefix for cache reuse" },
  { role: "user", content: "first user turn" },
  { role: "assistant", content: "first assistant answer" },
];

function replayMessages(signed: boolean): ChatMessage[] {
  return [
    ...STABLE_PREFIX,
    { role: "user", content: "read the example file" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_replay_1",
          name: "fs.read",
          args: { path: "docs/example.md" },
          rawArguments: '{"path":"docs/example.md"}',
          thoughtSignature: "thought_signature_placeholder",
        },
      ],
      reasoningBlock: {
        text: "the file must be inspected first",
        ...(signed ? { signature: "signature_placeholder" } : {}),
      },
    },
    {
      role: "tool",
      content: "example file contents",
      toolCallId: "call_replay_1",
      name: "fs.read",
      ok: true,
    },
  ];
}

export function requestForCase(
  route: ConformanceRoute,
  requestCase: RequestCase,
): CompletionRequest {
  const base: CompletionRequest = {
    provider: route.provider,
    model: route.model,
    messages: [...STABLE_PREFIX, { role: "user", content: "second user turn" }],
    maxTokens: 1_024,
    temperature: 0.2,
  };
  switch (requestCase) {
    case "minimal":
      return base;
    case "tools":
      return {
        ...base,
        tools: [...SNAPSHOT_TOOLS],
        toolChoice: "auto",
        parallelToolCalls: true,
      };
    case "images":
      return {
        ...base,
        messages: [
          ...STABLE_PREFIX,
          {
            role: "user",
            content: "describe this image",
            images: [
              {
                mediaType: "image/png",
                dataBase64: TINY_PNG_BASE64,
                path: "fixtures/tiny.png",
              },
            ],
          },
        ],
      };
    case "reasoning-control":
      return { ...base, thinking: { enabled: true, effort: "high" } };
    case "tool-loop-replay":
    case "tool-loop-replay-unsigned":
      return {
        ...base,
        messages: replayMessages(requestCase === "tool-loop-replay"),
        tools: [...SNAPSHOT_TOOLS],
        toolChoice: "auto",
        thinking: { enabled: true, effort: "medium" },
      };
  }
}

const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "modal-key",
  "modal-secret",
  "modal-session-id",
  "api-key",
]);

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] = SECRET_HEADERS.has(lower) ? "<redacted>" : value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|api_key|access_token)=)[^&]*/gi, "$1<redacted>");
}
