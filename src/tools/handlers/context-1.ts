import { detectSystem } from "../../os/detect.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";

export const toolRegistry_CONTEXT_1: Record<string, ToolHandler> = {
  async sysinfo() {
    return { ok: true, output: JSON.stringify(detectSystem(), null, 2) };
  },
};
