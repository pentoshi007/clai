import type { ToolDefinition } from "../../types.js";
import { MAX_FS_READ_FILES } from "../fs/read-input.js";

const FILE_PROPERTIES = {
  path: { type: "string", minLength: 1, description: "File or directory path (absolute, relative, or ~)." },
  offset: { type: "integer", minimum: 0, description: "1-indexed start line; 0 means 1. Alias: startLine." },
  limit: { type: "integer", minimum: 1, description: "Max lines (default 200, max 5000), or directory entries (default 500)." },
  startLine: { type: "integer", minimum: 0, description: "Inclusive start line. Prefer offset+limit OR startLine+endLine, not both." },
  endLine: { type: "integer", minimum: 1, description: "Inclusive end line, at least startLine/offset." },
  pattern: { type: "string", minLength: 1, description: 'JS regex source ("function\\\\s+foo") or /pattern/i; returns matching lines and context. A line range optionally narrows the search.' },
  context: { type: "integer", minimum: 0, maximum: 20, description: "Context lines before/after each pattern match (default 2)." },
  maxMatches: { type: "integer", minimum: 1, maximum: 100, description: "Max pattern matches (default 20)." },
  caseInsensitive: { type: "boolean", description: "Case-insensitive pattern matching; alternatively use /pattern/i." },
  maxBytes: { type: "integer", minimum: 1, description: "Maximum content bytes for this file, including range/pattern reads. Multi-file calls share a 256 KiB content budget; narrow filters to read more." },
};

export const FS_READ_DESCRIPTION = [
  "Read one text file or list one directory with {path,...options}.",
  `Only when several known files are needed together, use {files:[{path,...options},...]} with 1–${MAX_FS_READ_FILES} entries; single-file reads remain preferred when sufficient.`,
  'Example: {"files":[{"path":"src/app.ts","offset":1,"limit":80},{"path":"src/config.ts","pattern":"export","context":2}]}.',
  "Choose exactly one of path or files. In files mode, every entry requires path; all filters belong inside that entry, never at the top level. Do not add irrelevant files to fill the limit.",
  "Small path-only files return fully; large files auto-head. hasMore=true or clipping means incomplete coverage: continue using that file’s footer offset/limit, or narrow its filters. Do not repeat path-only hoping for more.",
  "Known range: offset+limit or startLine+endLine (1-indexed inclusive). Known symbol: pattern with optional context. Discover unknown paths with shell.exec rg first.",
  "Range/pattern lines are numbered N: text. Multi-file results are ordered, labeled by path, and report each file’s success or failure separately; successful reads remain available if another fails. Retry only failed/unfinished entries that are still needed.",
].join(" ");

export const FS_READ_PARAMETERS: ToolDefinition["parameters"] = {
  type: "object",
  properties: {
    ...FILE_PROPERTIES,
    files: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FS_READ_FILES,
      description: "Optional alternative to path: 1–6 relevant file objects, each with its own path and filters. Omit top-level path and filters when using files.",
      items: {
        type: "object",
        properties: FILE_PROPERTIES,
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  required: [],
  additionalProperties: false,
};
