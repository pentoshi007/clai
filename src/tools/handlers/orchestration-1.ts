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
import { runToolBatch } from "../batch/run-batch.js";

export const toolRegistry_ORCHESTRATION_1: Record<string, ToolHandler> = {
  async "tool.batch"(args, options) {
    return runToolBatch(args, options);
  },
};
