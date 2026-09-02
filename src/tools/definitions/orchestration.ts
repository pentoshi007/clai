import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_ORCHESTRATION: ToolDefinition[] = [
  def(
    "tool.check",
    'Check whether binaries/tools are available on PATH (and versions). Pass tools as an array, e.g. {"tools":["nmap","ffuf"]}.',
    {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: 'Tool names, e.g. ["nmap","ffuf"]',
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "tool.batch",
    "Run multiple tool calls as one batch (max 20). Default on_fail=continue (siblings keep running). Use cancel_pending for fail-fast, or cancel_on_fail/rules when later calls depend on earlier success.",
    {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Tool name (e.g. dns.lookup)",
              },
              args: { type: "object", description: "Arguments for that tool" },
              id: {
                type: "string",
                description:
                  "Optional stable id for on_fail rules (default: 1-based index as string)",
              },
              cancel_on_fail: {
                type: "array",
                items: { type: "string" },
                description:
                  "If THIS call fails, cancel these sibling ids (not yet finished)",
              },
            },
            required: ["name", "args"],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 20,
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          description:
            "Parallelism for all-safe read-only batches (default 3). Forced to 1 when mutates or on_fail is not continue.",
        },
        on_fail: {
          description:
            'Failure policy: "continue" (default), "cancel_pending" (fail-fast), or { rules: [{ if_failed, cancel, match? }] }',
          anyOf: [
            {
              type: "string",
              enum: ["continue", "cancel_pending", "cancel_rest", "fail_fast"],
            },
            {
              type: "object",
              properties: {
                rules: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      if_failed: {
                        anyOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } },
                        ],
                      },
                      cancel: {
                        anyOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } },
                        ],
                      },
                      match: { type: "string", enum: ["any", "all"] },
                    },
                    required: ["if_failed", "cancel"],
                    additionalProperties: false,
                  },
                  minItems: 1,
                },
                mode: {
                  type: "string",
                  enum: ["continue", "cancel_pending"],
                },
                if_failed: {
                  anyOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
                cancel: {
                  anyOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
                match: { type: "string", enum: ["any", "all"] },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["calls"],
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
