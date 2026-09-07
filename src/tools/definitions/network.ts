import type { ToolDefinition } from "../../types.js";
import { def } from "./define.js";

export const TOOL_DEFINITIONS_NETWORK: ToolDefinition[] = [
  def(
    "net.pingSweep",
    "Discover live hosts on a subnet/CIDR.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        method: {
          type: "string",
          enum: ["auto", "nmap", "arp", "native"],
        },
        timeoutMs: { type: "integer" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
];
