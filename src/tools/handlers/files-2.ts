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

export const toolRegistry_FILES_2: Record<string, ToolHandler> = {
  async "fs.edit"(args, options) {
    return fsEdit(
      requireString(args, "path"),
      requireString(args, "oldText"),
      requireString(args, "newText"),
      optionalNumber(args, "expectedReplacements"),
      { confirmed: options?.confirmed },
    );
  },
  async "fs.replaceLines"(args, options) {
    // Empty content / delete:true removes the line range (X6).
    let content: string;
    if (args.delete === true) {
      content = "";
    } else if (typeof args.content === "string") {
      content = requireStringAllowEmpty(args, "content");
    } else {
      throw new Error(
        'Tool argument "content" must be a string (use "" or delete:true to delete the line range)',
      );
    }
    return fsReplaceLines(
      requireString(args, "path"),
      requireNumber(args, "startLine"),
      requireNumber(args, "endLine"),
      content,
      { confirmed: options?.confirmed },
    );
  },
  async "fs.append"(args, options) {
    return fsAppend(
      requireString(args, "path"),
      requireString(args, "content"),
      {
        position: optionalString(args, "position") as
          "start" | "end" | undefined,
        expectedPriorBytes: optionalNumber(args, "expectedPriorBytes"),
        confirmed: options?.confirmed,
      },
    );
  },
  async "fs.delete"(args, options) {
    return fsDelete(
      requireString(args, "path"),
      typeof args.recursive === "boolean" ? args.recursive : undefined,
      { confirmed: options?.confirmed },
    );
  },
};
