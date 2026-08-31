import { toolCheckHandler } from "../capabilities.js";
import { wordlistFind } from "../wordlists.js";
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

export const toolRegistry_ORCHESTRATION_2: Record<string, ToolHandler> = {
  async "tool.check"(args) {
    return toolCheckHandler(args);
  },
  async "wordlist.find"(args) {
    const expand = typeof args.expand === "boolean" ? args.expand : undefined;
    return wordlistFind({
      query: requireString(args, "query"),
      ...(expand !== undefined ? { expand } : {}),
    });
  },
};
