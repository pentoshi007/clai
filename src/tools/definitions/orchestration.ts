import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_ORCHESTRATION: ToolDefinition[] = [
  def(
    "tool.check",
    'Check up to 40 binaries/tools per call for availability on PATH (and versions). Pass tools as an array, e.g. {"tools":["nmap","ffuf"]}.',
    {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 40,
          description: 'Tool names, e.g. ["nmap","ffuf"]',
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "wordlist.find",
    "Locate wordlists on disk for fuzzing/directory scans.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        expand: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
];
