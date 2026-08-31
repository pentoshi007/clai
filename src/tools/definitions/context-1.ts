import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_CONTEXT_1: ToolDefinition[] = [
  def("sysinfo", "OS/environment facts for this machine.", emptyObject, {
    readOnly: true,
    askMode: true,
  }),
];
