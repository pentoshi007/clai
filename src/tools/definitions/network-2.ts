import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_NETWORK_2: ToolDefinition[] = [
  def(
    "dns.lookup",
    "DNS query for a single record type. Built-in (Node resolver + DNS-over-HTTPS) — does NOT require dig/nslookup/host.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        record: {
          type: "string",
          description: "A, AAAA, MX, TXT, NS, CNAME, SOA, SRV, CAA, PTR, ANY",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "whois.lookup",
    "Registration/ownership lookup (RDAP + port-43). Built-in — does NOT require the whois binary.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
];
