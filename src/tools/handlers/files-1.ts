import { safeCwd } from "../../os/cwd.js";
import {
  fsEdit,
  fsDelete,
  fsList,
  fsRead,
  fsSearch,
  fsWrite,
  fsWriteMany,
  fsReplaceLines,
  fsAppend,
  type FileWrite,
} from "../fs.js";
import { getNetworkContext } from "../network-context.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
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
  async "fs.list"(args, options) {
    return fsList(optionalString(args, "path") ?? safeCwd(), {
      maxEntries: optionalNumber(args, "maxEntries"),
      confirmed: options?.confirmed,
    });
  },
  async "fs.search"(args, options) {
    return fsSearch(
      requireString(args, "pattern"),
      optionalString(args, "path"),
      {
        confirmed: options?.confirmed,
        maxMatches: optionalNumber(args, "maxMatches"),
        maxPerFile: optionalNumber(args, "maxPerFile"),
        glob: optionalString(args, "glob"),
        caseInsensitive: optionalBoolean(args, "caseInsensitive"),
        fixedString: optionalBoolean(args, "fixedString"),
        context: optionalNumber(args, "context"),
        filesOnly: optionalBoolean(args, "filesOnly"),
        hidden: optionalBoolean(args, "hidden"),
        timeoutMs: optionalNumber(args, "timeoutMs"),
      },
    );
  },
};
