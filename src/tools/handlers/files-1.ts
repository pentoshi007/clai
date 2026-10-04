import {
  fsRead,
  fsWrite,
  fsWriteMany,
  type FileWrite,
} from "../fs.js";
import { type ToolHandler } from "../tool-types.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
} from "./args.js";

export const toolRegistry_FILES_1: Record<string, ToolHandler> = {
  async "fs.read"(args, options) {
    return fsRead(requireString(args, "path"), {
      maxBytes: optionalNumber(args, "maxBytes"),
      offset: optionalNumber(args, "offset"),
      limit: optionalNumber(args, "limit"),
      startLine: optionalNumber(args, "startLine"),
      endLine: optionalNumber(args, "endLine"),
      pattern: optionalString(args, "pattern"),
      context: optionalNumber(args, "context"),
      maxMatches: optionalNumber(args, "maxMatches"),
      caseInsensitive: optionalBoolean(args, "caseInsensitive"),
      confirmed: options?.confirmed,
    });
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
