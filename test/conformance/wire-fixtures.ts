export type WireFamily =
  | "chat_completions"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "meta_responses"
  | "ollama_chat";

export type ConformanceScenario =
  | "answer"
  | "reasoning"
  | "tools"
  | "usage"
  | "error"
  | "terminal";

export const ANSWER_TEXT = "conformance answer";
export const REASONING_TEXT = "weighing two options";
export const TOOL_CANONICAL_NAME = "fs.read";
export const TOOL_WIRE_NAME = "fs_read";
export const TOOL_CALL_ID = "call_conformance_1";
export const TOOL_ARGS = { path: "docs/example.md" } as const;
export const TOOL_ARGS_JSON = JSON.stringify(TOOL_ARGS);
export const ANTHROPIC_THINKING_SIGNATURE = "sig_conformance";
export const META_ENCRYPTED_REASONING = "enc_conformance";
export const GEMINI_THOUGHT_SIGNATURE = "gemini_sig_conformance";

export const PROMPT_TOKENS = 1_234;
export const COMPLETION_TOKENS = 56;
export const CACHED_PROMPT_TOKENS = 1_000;
export const REASONING_TOKENS = 12;

export const ERROR_STATUS = 429;
export const ERROR_MESSAGE = "conformance rate limit";

export interface ScenarioSpec {
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly cache: boolean;
}

export function scenarioSpec(scenario: ConformanceScenario): ScenarioSpec {
  return {
    reasoning: scenario === "reasoning",
    tools: scenario === "tools",
    cache: scenario === "usage",
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(): Response {
  return jsonResponse(
    { error: { message: ERROR_MESSAGE, type: "rate_limit_error" } },
    ERROR_STATUS,
  );
}

export function textStreamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatUsage(spec: ScenarioSpec): Record<string, unknown> {
  return {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
    ...(spec.cache
      ? {
          prompt_tokens_details: { cached_tokens: CACHED_PROMPT_TOKENS },
          completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
        }
      : {}),
  };
}

function chatToolCalls(): Array<Record<string, unknown>> {
  return [
    {
      id: TOOL_CALL_ID,
      type: "function",
      function: { name: TOOL_WIRE_NAME, arguments: TOOL_ARGS_JSON },
    },
  ];
}

function chatComplete(model: string, spec: ScenarioSpec): Response {
  return jsonResponse({
    id: "chatcmpl_conformance",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: ANSWER_TEXT,
          ...(spec.reasoning ? { reasoning_content: REASONING_TEXT } : {}),
          ...(spec.tools ? { tool_calls: chatToolCalls() } : {}),
        },
        finish_reason: spec.tools ? "tool_calls" : "stop",
      },
    ],
    usage: chatUsage(spec),
  });
}

function chatStream(model: string, spec: ScenarioSpec): Response {
  const frames: string[] = [
    sse({ id: "chatcmpl_conformance", model, choices: [{ index: 0, delta: { role: "assistant" } }] }),
  ];
  if (spec.reasoning) {
    frames.push(
      sse({ choices: [{ index: 0, delta: { reasoning_content: REASONING_TEXT } }] }),
    );
  }
  frames.push(sse({ choices: [{ index: 0, delta: { content: ANSWER_TEXT } }] }));
  if (spec.tools) {
    frames.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: TOOL_CALL_ID,
                  type: "function",
                  function: { name: TOOL_WIRE_NAME, arguments: "" },
                },
              ],
            },
          },
        ],
      }),
    );
    frames.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS_JSON } }],
            },
          },
        ],
      }),
    );
  }
  frames.push(
    sse({
      choices: [
        { index: 0, delta: {}, finish_reason: spec.tools ? "tool_calls" : "stop" },
      ],
      usage: chatUsage(spec),
    }),
  );
  frames.push("data: [DONE]\n\n");
  return textStreamResponse(frames);
}

function anthropicUsage(spec: ScenarioSpec): Record<string, unknown> {
  return {
    input_tokens: spec.cache ? PROMPT_TOKENS - CACHED_PROMPT_TOKENS : PROMPT_TOKENS,
    output_tokens: COMPLETION_TOKENS,
    ...(spec.cache ? { cache_read_input_tokens: CACHED_PROMPT_TOKENS } : {}),
  };
}

function anthropicComplete(model: string, spec: ScenarioSpec): Response {
  const content: Array<Record<string, unknown>> = [];
  if (spec.reasoning) {
    content.push({
      type: "thinking",
      thinking: REASONING_TEXT,
      signature: ANTHROPIC_THINKING_SIGNATURE,
    });
  }
  content.push({ type: "text", text: ANSWER_TEXT });
  if (spec.tools) {
    content.push({
      type: "tool_use",
      id: TOOL_CALL_ID,
      name: TOOL_WIRE_NAME,
      input: TOOL_ARGS,
    });
  }
  return jsonResponse({
    id: "msg_conformance",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: spec.tools ? "tool_use" : "end_turn",
    usage: anthropicUsage(spec),
  });
}

function anthropicStream(model: string, spec: ScenarioSpec): Response {
  const frames: string[] = [
    sse({
      type: "message_start",
      message: { id: "msg_conformance", model, usage: anthropicUsage(spec) },
    }),
  ];
  let index = 0;
  if (spec.reasoning) {
    frames.push(
      sse({ type: "content_block_start", index, content_block: { type: "thinking" } }),
      sse({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: REASONING_TEXT },
      }),
      sse({
        type: "content_block_delta",
        index,
        delta: {
          type: "signature_delta",
          signature: ANTHROPIC_THINKING_SIGNATURE,
        },
      }),
      sse({ type: "content_block_stop", index }),
    );
    index += 1;
  }
  frames.push(
    sse({ type: "content_block_start", index, content_block: { type: "text" } }),
    sse({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: ANSWER_TEXT },
    }),
    sse({ type: "content_block_stop", index }),
  );
  index += 1;
  if (spec.tools) {
    frames.push(
      sse({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_WIRE_NAME },
      }),
      sse({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: TOOL_ARGS_JSON },
      }),
      sse({ type: "content_block_stop", index }),
    );
  }
  frames.push(
    sse({
      type: "message_delta",
      delta: { stop_reason: spec.tools ? "tool_use" : "end_turn" },
      usage: { output_tokens: COMPLETION_TOKENS },
    }),
    sse({ type: "message_stop" }),
  );
  return textStreamResponse(frames);
}

function geminiUsage(): Record<string, unknown> {
  return {
    promptTokenCount: PROMPT_TOKENS,
    candidatesTokenCount: COMPLETION_TOKENS,
    totalTokenCount: PROMPT_TOKENS + COMPLETION_TOKENS,
  };
}

function geminiParts(spec: ScenarioSpec): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (spec.reasoning) parts.push({ text: REASONING_TEXT, thought: true });
  parts.push({ text: ANSWER_TEXT });
  if (spec.tools) {
    parts.push({
      functionCall: { name: TOOL_WIRE_NAME, args: TOOL_ARGS, id: TOOL_CALL_ID },
      thoughtSignature: GEMINI_THOUGHT_SIGNATURE,
    });
  }
  return parts;
}

function geminiComplete(spec: ScenarioSpec): Response {
  return jsonResponse({
    candidates: [
      {
        content: { parts: geminiParts(spec), role: "model" },
        finishReason: "STOP",
      },
    ],
    usageMetadata: geminiUsage(),
  });
}

function geminiStream(spec: ScenarioSpec): Response {
  const frames = geminiParts(spec).map((part) =>
    sse({ candidates: [{ content: { parts: [part], role: "model" } }] }),
  );
  frames.push(
    sse({
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: geminiUsage(),
    }),
  );
  return textStreamResponse(frames);
}

function metaUsage(): Record<string, unknown> {
  return {
    input_tokens: PROMPT_TOKENS,
    output_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  };
}

function metaOutput(spec: ScenarioSpec): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (spec.reasoning) {
    output.push({
      type: "reasoning",
      id: "rs_conformance",
      summary: [{ type: "summary_text", text: REASONING_TEXT }],
      encrypted_content: META_ENCRYPTED_REASONING,
    });
  }
  output.push({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: ANSWER_TEXT }],
  });
  if (spec.tools) {
    output.push({
      type: "function_call",
      id: TOOL_CALL_ID,
      call_id: TOOL_CALL_ID,
      name: TOOL_WIRE_NAME,
      arguments: TOOL_ARGS_JSON,
    });
  }
  return output;
}

function metaComplete(spec: ScenarioSpec): Response {
  return jsonResponse({
    id: "resp_conformance",
    status: "completed",
    output: metaOutput(spec),
    usage: metaUsage(),
  });
}

function metaStream(spec: ScenarioSpec): Response {
  const frames: string[] = [
    sse({ type: "response.created", response: { id: "resp_conformance" } }),
  ];
  if (spec.reasoning) {
    frames.push(
      sse({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_conformance",
        delta: REASONING_TEXT,
      }),
      sse({
        type: "response.reasoning_summary_text.done",
        item_id: "rs_conformance",
        text: REASONING_TEXT,
      }),
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_conformance",
          summary: [{ type: "summary_text", text: REASONING_TEXT }],
          encrypted_content: META_ENCRYPTED_REASONING,
        },
      }),
    );
  }
  frames.push(
    sse({ type: "response.output_text.delta", delta: ANSWER_TEXT }),
  );
  if (spec.tools) {
    frames.push(
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: TOOL_CALL_ID,
          call_id: TOOL_CALL_ID,
          name: TOOL_WIRE_NAME,
          arguments: "",
        },
      }),
      sse({
        type: "response.function_call_arguments.done",
        item_id: TOOL_CALL_ID,
        arguments: TOOL_ARGS_JSON,
      }),
    );
  }
  frames.push(
    sse({
      type: "response.completed",
      response: {
        id: "resp_conformance",
        status: "completed",
        output: metaOutput(spec),
        usage: metaUsage(),
      },
    }),
  );
  return textStreamResponse(frames);
}

function ollamaToolCalls(): Array<Record<string, unknown>> {
  return [
    { function: { name: TOOL_WIRE_NAME, arguments: TOOL_ARGS } },
  ];
}

function ollamaComplete(model: string, spec: ScenarioSpec): Response {
  return jsonResponse({
    model,
    message: {
      role: "assistant",
      content: ANSWER_TEXT,
      ...(spec.tools ? { tool_calls: ollamaToolCalls() } : {}),
    },
    done: true,
    done_reason: "stop",
    prompt_eval_count: PROMPT_TOKENS,
    eval_count: COMPLETION_TOKENS,
  });
}

function ollamaStream(model: string, spec: ScenarioSpec): Response {
  const lines: string[] = [
    `${JSON.stringify({ model, message: { role: "assistant", content: ANSWER_TEXT }, done: false })}\n`,
  ];
  if (spec.tools) {
    lines.push(
      `${JSON.stringify({ model, message: { role: "assistant", content: "", tool_calls: ollamaToolCalls() }, done: false })}\n`,
    );
  }
  lines.push(
    `${JSON.stringify({
      model,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: PROMPT_TOKENS,
      eval_count: COMPLETION_TOKENS,
    })}\n`,
  );
  return textStreamResponse(lines);
}

export type WireMode = "complete" | "stream";

export const TOOL_FINISH_REASON: Record<WireFamily, Record<WireMode, string>> = {
  chat_completions: { complete: "tool_calls", stream: "tool_calls" },
  anthropic_messages: { complete: "tool_calls", stream: "tool_calls" },
  gemini_generate_content: { complete: "STOP", stream: "STOP" },
  meta_responses: { complete: "tool_calls", stream: "completed" },
  ollama_chat: { complete: "tool_calls", stream: "tool_calls" },
};

export const UNSUPPORTED_SCENARIOS: Partial<
  Record<WireFamily, Partial<Record<ConformanceScenario, string>>>
> = {
  ollama_chat: { reasoning: "no native thinking field is parsed" },
};

export function buildWireResponse(
  family: WireFamily,
  mode: WireMode,
  scenario: ConformanceScenario,
  model: string,
): Response {
  if (scenario === "error") return errorResponse();
  const spec = scenarioSpec(scenario);
  if (mode === "complete") {
    switch (family) {
      case "chat_completions":
        return chatComplete(model, spec);
      case "anthropic_messages":
        return anthropicComplete(model, spec);
      case "gemini_generate_content":
        return geminiComplete(spec);
      case "meta_responses":
        return metaComplete(spec);
      case "ollama_chat":
        return ollamaComplete(model, spec);
    }
  }
  switch (family) {
    case "chat_completions":
      return chatStream(model, spec);
    case "anthropic_messages":
      return anthropicStream(model, spec);
    case "gemini_generate_content":
      return geminiStream(spec);
    case "meta_responses":
      return metaStream(spec);
    case "ollama_chat":
      return ollamaStream(model, spec);
  }
}
