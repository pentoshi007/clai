import type { ToolDefinition } from "../../types.js";
import { def } from "./define.js";
import { FS_READ_DESCRIPTION, FS_READ_PARAMETERS } from "./fs-read.js";

export const TOOL_DEFINITIONS_FILES: ToolDefinition[] = [
  def(
    "fs.read",
    FS_READ_DESCRIPTION,
    FS_READ_PARAMETERS,
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
