import { registerWireNamesFor } from "../../llm/tool-protocol.js";
import type { ToolDefinition } from "../../types.js";

const TIMED_TOOLS = new Set([
  "shell.exec",
  "http.fetch",
  "web.fetch",
  "web.search",
  "image.ocr",
  "pdf.read",
]);

export function def(
  name: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  flags: Partial<Pick<ToolDefinition, "readOnly" | "mutates" | "askMode">> = {},
): ToolDefinition {
  const timedParameters: ToolDefinition["parameters"] = !TIMED_TOOLS.has(name)
    ? parameters
    : {
        ...parameters,
        properties: {
          ...(parameters.properties ?? {}),
          timeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: 1_800_000,
            description: "Timeout in ms (default 40000); raise it for slow work.",
            ...((parameters.properties?.timeoutMs as
              Record<string, unknown> | undefined) ?? {}),
          },
        },
      };
  const wireName = registerWireNamesFor(name);
  return {
    name,
    wireName,
    description,
    parameters: timedParameters,
    ...flags,
  };
}

export const emptyObject = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
  additionalProperties: false,
};
