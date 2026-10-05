import {
  fsRead,
  fsWrite,
  fsWriteMany,
  type FileWrite,
} from "../fs.js";
import { type ToolHandler } from "../tool-types.js";
import { requireString } from "./args.js";
import { parseFsReadInput } from "../fs/read-input.js";
import { fsReadMany } from "../fs/read-many.js";

export const toolRegistry_FILES_1: Record<string, ToolHandler> = {
  async "fs.read"(args, options) {
    const input = parseFsReadInput(args);
    if (!input.ok) return { ok: false, exitCode: 1, output: input.error };
    if (input.multiple) return fsReadMany(input.files, options);
    const { path, ...filters } = input.files[0]!;
    return fsRead(path, { ...filters, confirmed: options?.confirmed, signal: options?.signal });
  },
  async "fs.write"(args, options) {
    return fsWrite(
      requireString(args, "path"),
      requireString(args, "content"),
      { confirmed: options?.confirmed },
    );
  },
  async "fs.writeMany"(args, options) {
    const raw = args.files;
    if (!Array.isArray(raw)) {
      throw new Error(
        'fs.writeMany requires a "files" array of { path, content } objects',
      );
    }
    const files = raw as FileWrite[];
    return fsWriteMany(files, { confirmed: options?.confirmed });
  },
};
