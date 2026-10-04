import type { ToolDefinition } from "../../types.js";
import { def } from "./define.js";

export const TOOL_DEFINITIONS_FILES: ToolDefinition[] = [
  def(
    "fs.read",
    [
      "Read a text file (or list a directory if path is a dir).",
      "Decision guide:",
      "(1) Small/unknown path → fs.read {path} only; small files return fully.",
      "(2) If output has auto-head or hasMore=true → you do NOT have the whole file; continue with the exact next offset/limit from the footer (do not re-call path-only).",
      "(3) Known line range → offset+limit or startLine+endLine (1-indexed inclusive).",
      "(4) Looking for a symbol/string → pattern (regex or /pattern/i) with optional context, OR search with shell.exec then fs.read around hit lines.",
      "(5) Prefer partial/pattern reads for large files — saves tokens and avoids re-reads.",
      "Lines in the body are numbered as N: text. Headers report path/range/matches/hasMore.",
    ].join(" "),
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute, relative, or ~)",
        },
        offset: {
          type: "integer",
          description:
            "1-indexed start line for paging (alias: startLine). 0 is accepted and treated as 1.",
        },
        limit: {
          type: "integer",
          description:
            "Max lines when paging (default 200), or max directory entries (default 500)",
        },
        startLine: {
          type: "integer",
          description: "1-indexed inclusive start line (alias of offset)",
        },
        endLine: {
          type: "integer",
          description: "1-indexed inclusive end line",
        },
        pattern: {
          type: "string",
          description:
            'Match windows: JS regex source ("function\\\\s+foo") or /pattern/flags. Use for symbols/strings instead of loading the whole file.',
        },
        context: {
          type: "integer",
          description: "Lines of context around each pattern match (default 2)",
        },
        maxMatches: {
          type: "integer",
          description: "Max pattern matches (default 20, max 100)",
        },
        caseInsensitive: {
          type: "boolean",
          description: "Case-insensitive pattern match (or use /pattern/i)",
        },
        maxBytes: {
          type: "integer",
          description: "Hard max bytes for full reads of small/medium files",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.write",
    "Create a new file or fully overwrite one with complete content. For an existing file already read, prefer fs.edit/replaceLines; if a full rewrite is necessary, preserve the complete file and inspect the returned diff before continuing.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: {
          type: "string",
          description: "Full file contents in one call",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.writeMany",
    "Write multiple complete files in one call (scaffold). Max 50 files.",
    {
      type: "object",
      properties: {
        files: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.edit",
    "Surgical in-place edit. Use only after reading or searching the current file and copying the exact oldText, including whitespace and line endings; if it is not known, use fs.read first. After a no-match error, do not retry unchanged oldText.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: {
          type: "string",
          minLength: 1,
          description: "Exact current text to replace, copied from the latest file evidence",
        },
        newText: { type: "string", description: "Intended replacement text" },
        expectedReplacements: { type: "integer" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.replaceLines",
    "Replace a 1-indexed inclusive line range after reading the file. Empty content (or delete:true) deletes that range.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: {
          type: "string",
          description:
            "Replacement text. Empty string deletes the line range (no space hack).",
        },
        delete: {
          type: "boolean",
          description: 'If true, delete the range (same as content:"")',
        },
      },
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.append",
    "Append (or prepend) content. Positional and safe to repeat; expectedPriorBytes is an optional advisory cross-check.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        position: { type: "string", enum: ["start", "end"] },
        expectedPriorBytes: {
          type: "integer",
          description:
            "Optional byte count from the prior receipt. A stale value no longer blocks the append; it only fails if the file shrank below it.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.delete",
    "Delete a file or directory.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
];
