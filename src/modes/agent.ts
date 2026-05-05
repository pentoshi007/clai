import type { ChatMessage, ProviderId, ToolCall } from "../types.js";
import { completeWithProvider } from "../llm/router.js";
import { renderAgentSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { classifyToolCall } from "../safety/classifier.js";
import { availableToolNames, runToolCall } from "../tools/registry.js";

export interface AgentOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
}

function parseToolCall(text: string): ToolCall | undefined {
  const match =
    text.match(/```tool\s*([\s\S]*?)```/i) ??
    text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as Partial<ToolCall>;
    if (
      typeof parsed.name === "string" &&
      parsed.args &&
      typeof parsed.args === "object"
    ) {
      return {
        name: parsed.name,
        args: parsed.args as Record<string, unknown>,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function runAgent(
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  const config = getConfig();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${renderAgentSystemPrompt(availableToolNames().join(", "))}\nWhen you need a tool, respond with a JSON tool call in a fenced block labelled tool. Otherwise answer normally.`,
    },
    ...(options.history ?? []),
    { role: "user", content: prompt },
  ];

  const first = await completeWithProvider({
    provider: options.provider ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    messages,
    temperature: 0.2,
    maxTokens: 1_500,
  });

  const call = parseToolCall(first.text);
  if (!call) {
    return first.text;
  }

  const decision = classifyToolCall(call);
  if (decision.level === "block") {
    return `Blocked tool call ${call.name}: ${decision.reason}`;
  }

  if (decision.level === "confirm" && !options.autoConfirm) {
    return `Tool call requires confirmation: ${call.name}. Reason: ${decision.reason}. Re-run with explicit confirmation once the confirmation UI is active.`;
  }

  const toolResult = await runToolCall(call);
  messages.push({ role: "assistant", content: first.text });
  messages.push({
    role: "tool",
    content: `Tool ${call.name} result:\n${toolResult.output}`,
  });

  const final = await completeWithProvider({
    provider: first.provider,
    model: first.model,
    messages,
    temperature: 0.2,
    maxTokens: 1_500,
  });

  return final.text;
}
