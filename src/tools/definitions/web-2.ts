import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_WEB_2: ToolDefinition[] = [
  def(
    "web.search",
    "Search the web for current information. Use for volatile facts and research.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer" },
        fetchTop: {
          type: "integer",
          description: "Fetch top N pages (0-3)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "web.fetch",
    "Fetch a URL as readable text or metadata for research.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: {
          type: "integer",
          description:
            "Maximum page-body bytes captured from the wire; raise it when metadata reports truncated=true",
        },
        includeHeaders: { type: "boolean" },
        includeTls: { type: "boolean" },
        includeTiming: { type: "boolean" },
        includeRedirectChain: { type: "boolean" },
        responseMode: {
          type: "string",
          enum: ["readable", "raw"],
          description:
            "Body formatting: readable (default) or raw response source. Use raw for client-rendered pages whose HTML contains little readable text.",
        },
        responsePart: {
          type: "string",
          enum: ["full", "headers", "body"],
          description:
            "Return the normal full result (default), response headers/metadata only, or body only",
        },
        topLines: {
          type: "integer",
          minimum: 0,
          description:
            "Return only the first N rendered lines. Everything after them is dropped from the model's view behind an omission marker (combine with bottomLines for head+tail).",
        },
        bottomLines: {
          type: "integer",
          minimum: 0,
          description:
            "Return only the last N rendered lines. Everything before them is dropped from the model's view behind an omission marker (combine with topLines for head+tail).",
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 0,
          description:
            "Strict byte ceiling on the final rendered output. Cuts content the model would otherwise see; a body slice is preserved but the rest is dropped.",
        },
        redactSensitive: { type: "boolean" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
];
