import {
  ANSWER_TEXT,
  REASONING_TEXT,
  TOOL_CALL_ID,
  TOOL_WIRE_NAME,
  textStreamResponse,
  type WireFamily,
} from "./wire-fixtures.js";

export type EofCase =
  | "prose-only"
  | "reasoning-only"
  | "tool-id-only"
  | "partial-tool-args";

export const EOF_CASES: readonly EofCase[] = [
  "prose-only",
  "reasoning-only",
  "tool-id-only",
  "partial-tool-args",
];

export const PARTIAL_TOOL_ARGS = '{"path":"docs/exa';

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatFrames(eofCase: EofCase): string[] {
  const role = sse({ choices: [{ index: 0, delta: { role: "assistant" } }] });
  switch (eofCase) {
    case "prose-only":
      return [role, sse({ choices: [{ index: 0, delta: { content: ANSWER_TEXT } }] })];
    case "reasoning-only":
      return [
        role,
        sse({ choices: [{ index: 0, delta: { reasoning_content: REASONING_TEXT } }] }),
      ];
    case "tool-id-only":
      return [
        role,
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
      ];
    case "partial-tool-args":
      return [
        role,
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
                    function: { name: TOOL_WIRE_NAME, arguments: PARTIAL_TOOL_ARGS },
                  },
                ],
              },
            },
          ],
        }),
      ];
  }
}

function anthropicFrames(eofCase: EofCase): string[] {
  const start = sse({
    type: "message_start",
    message: { id: "msg_conformance", usage: { input_tokens: 10 } },
  });
  switch (eofCase) {
    case "prose-only":
      return [
        start,
        sse({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ANSWER_TEXT },
        }),
      ];
    case "reasoning-only":
      return [
        start,
        sse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: REASONING_TEXT },
        }),
      ];
    case "tool-id-only":
      return [
        start,
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_WIRE_NAME },
        }),
      ];
    case "partial-tool-args":
      return [
        start,
        sse({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: TOOL_CALL_ID, name: TOOL_WIRE_NAME },
        }),
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: PARTIAL_TOOL_ARGS },
        }),
      ];
  }
}

function geminiFrames(eofCase: EofCase): string[] {
  const part = (value: Record<string, unknown>): string =>
    sse({ candidates: [{ content: { parts: [value], role: "model" } }] });
  switch (eofCase) {
    case "prose-only":
      return [part({ text: ANSWER_TEXT })];
    case "reasoning-only":
      return [part({ text: REASONING_TEXT, thought: true })];
    case "tool-id-only":
      return [part({ functionCall: { name: TOOL_WIRE_NAME, id: TOOL_CALL_ID } })];
    case "partial-tool-args":
      return [part({ text: ANSWER_TEXT })];
  }
}

function metaFrames(eofCase: EofCase): string[] {
  const created = sse({ type: "response.created", response: { id: "resp_conformance" } });
  switch (eofCase) {
    case "prose-only":
      return [created, sse({ type: "response.output_text.delta", delta: ANSWER_TEXT })];
    case "reasoning-only":
      return [
        created,
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_conformance",
          delta: REASONING_TEXT,
        }),
      ];
    case "tool-id-only":
      return [
        created,
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: TOOL_CALL_ID,
            call_id: TOOL_CALL_ID,
            name: TOOL_WIRE_NAME,
            arguments: "",
          },
        }),
      ];
    case "partial-tool-args":
      return [
        created,
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: TOOL_CALL_ID,
            call_id: TOOL_CALL_ID,
            name: TOOL_WIRE_NAME,
            arguments: "",
          },
        }),
        sse({
          type: "response.function_call_arguments.delta",
          item_id: TOOL_CALL_ID,
          delta: PARTIAL_TOOL_ARGS,
        }),
      ];
  }
}

function ollamaFrames(eofCase: EofCase): string[] {
  const line = (payload: unknown): string => `${JSON.stringify(payload)}\n`;
  switch (eofCase) {
    case "prose-only":
    case "partial-tool-args":
      return [line({ message: { role: "assistant", content: ANSWER_TEXT }, done: false })];
    case "reasoning-only":
      return [line({ message: { role: "assistant", content: "" }, done: false })];
    case "tool-id-only":
      return [
        line({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: TOOL_WIRE_NAME, arguments: {} } }],
          },
          done: false,
        }),
      ];
  }
}

export function buildEofResponse(family: WireFamily, eofCase: EofCase): Response {
  switch (family) {
    case "chat_completions":
      return textStreamResponse(chatFrames(eofCase));
    case "anthropic_messages":
      return textStreamResponse(anthropicFrames(eofCase));
    case "gemini_generate_content":
      return textStreamResponse(geminiFrames(eofCase));
    case "meta_responses":
      return textStreamResponse(metaFrames(eofCase));
    case "ollama_chat":
      return textStreamResponse(ollamaFrames(eofCase));
  }
}
