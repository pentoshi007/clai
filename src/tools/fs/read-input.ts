import type { FsReadOptions } from "../fs.js";

export const MAX_FS_READ_FILES = 6;

export const FS_READ_OPTION_KEYS = [
  "offset", "limit", "startLine", "endLine", "pattern", "context",
  "maxMatches", "caseInsensitive", "maxBytes",
] as const;

export interface FsReadFileInput extends FsReadOptions {
  path: string;
}

type ReadInputResult =
  | { ok: true; files: FsReadFileInput[]; multiple: boolean }
  | { ok: false; error: string };

const USAGE = 'Use {"path":"src/app.ts","offset":1,"limit":80} for one file, or {"files":[{"path":"src/app.ts","limit":80},{"path":"src/config.ts","pattern":"export","context":2}]} for 1–6 relevant files. Put each file’s options inside its entry; use exactly one of path or files.';

function readFileInput(raw: unknown, label: string): FsReadFileInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object with a path and optional read filters.`);
  }
  const args = raw as Record<string, unknown>;
  const unknown = Object.keys(args).find((key) => key !== "path" && !FS_READ_OPTION_KEYS.includes(key as (typeof FS_READ_OPTION_KEYS)[number]));
  if (unknown) throw new Error(`${label}.${unknown} is not a read option. Put offset/limit, startLine/endLine, pattern/context, maxMatches, caseInsensitive or maxBytes directly beside path.`);
  if (typeof args.path !== "string" || !args.path.trim()) {
    throw new Error(`${label}.path must be a non-empty string.`);
  }
  const file: FsReadFileInput = { path: args.path };
  for (const key of FS_READ_OPTION_KEYS) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (key === "pattern") {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label}.pattern must be a non-empty regex string.`);
      }
      file.pattern = value;
    } else if (key === "caseInsensitive") {
      if (typeof value !== "boolean") throw new Error(`${label}.${key} must be true or false.`);
      file.caseInsensitive = value;
    } else {
      const number = typeof value === "string" && value.trim() ? Number(value) : value;
      const minimum = key === "offset" || key === "startLine" || key === "context" ? 0 : 1;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum) {
        throw new Error(`${label}.${key} must be an integer >= ${minimum}.`);
      }
      file[key] = number;
    }
  }
  return file;
}

export function parseFsReadInput(args: Record<string, unknown>): ReadInputResult {
  try {
    if (args.files !== undefined && args.files !== null) {
      if (args.path !== undefined && args.path !== null) {
        throw new Error("fs.read received both path and files.");
      }
      if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > MAX_FS_READ_FILES) {
        throw new Error(`fs.read files must be an array of 1–${MAX_FS_READ_FILES} file objects.`);
      }
      const sharedOption = FS_READ_OPTION_KEYS.find((key) => args[key] !== undefined && args[key] !== null);
      if (sharedOption) throw new Error(`Move ${sharedOption} into the appropriate files entry.`);
      const unknown = Object.keys(args).find((key) => key !== "files" && key !== "path");
      if (unknown) throw new Error(`fs.read.${unknown} is not supported in files mode; place read filters directly inside each file entry.`);
      return {
        ok: true,
        files: args.files.map((file, index) => readFileInput(file, `files[${index}]`)),
        multiple: true,
      };
    }
    const { files: _unused, ...single } = args;
    return { ok: true, files: [readFileInput(single, "fs.read")], multiple: false };
  } catch (error) {
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` };
  }
}
