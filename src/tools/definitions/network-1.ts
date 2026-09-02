import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_NETWORK_1: ToolDefinition[] = [
  def(
    "net.scan",
    'Validated nmap port/service scan. Put only the IP, hostname, or CIDR in target; put a port expression such as 1-1000 in ports without a -p prefix. Use profile for scan behavior: scanType syn/tcp/udp/ping, serviceDetect boolean, scripts as an array of safe NSE names (for -sC use ["default"]), timing T0-T5, or topPorts. Runs synchronously unless background or responder is explicitly selected.',
    {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "IP, hostname, or CIDR only; never append nmap flags",
        },
        ports: {
          type: "string",
          description:
            "Port or range expression, e.g. 443, 80,443, or 1-1000; omit -p",
        },
        profile: {
          type: "object",
          description: "Structured nmap options",
          properties: {
            scanType: {
              type: "string",
              enum: ["syn", "tcp", "udp", "ping"],
            },
            topPorts: { type: "integer", minimum: 1, maximum: 65535 },
            serviceDetect: { type: "boolean" },
            scripts: {
              type: "array",
              items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
              description:
                'Safe NSE script names; use ["default"] for nmap -sC',
            },
            timing: {
              type: "string",
              enum: ["T0", "T1", "T2", "T3", "T4", "T5"],
            },
            udp: { type: "boolean" },
          },
          additionalProperties: false,
        },
        flags: {
          type: "string",
          description: "Legacy flags string",
        },
        background: {
          type: "boolean",
          description: "Run as a normal pollable durable job",
        },
        responder: {
          type: "boolean",
          description: "Delegate as a fire-and-continue Responder job",
        },
        parentTaskId: {
          type: "string",
          description:
            'Plan task id that owns this delegation (e.g. "t3"). Required whenever more than one task could own it; the Responder child is created under exactly this task.',
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "net.context",
    "Local network context (interfaces, routes summary).",
    emptyObject,
    { readOnly: true, askMode: true },
  ),
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
