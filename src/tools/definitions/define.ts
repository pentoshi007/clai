import { registerWireNamesFor } from "../../llm/tool-protocol.js";
import type { ToolDefinition } from "../../types.js";

const TIMED_TOOLS = new Set([
  "shell.exec",
  "http.fetch",
  "web.fetch",
  "web.search",
  "net.scan",
  "net.pingSweep",
  "pentest.recon",
  "pentest.webDiscover",
  "pentest.apiEnumerate",
  "pentest.authCompare",
  "pentest.scanStatus",
  "pkg.install",
  "tool.batch",
  "tool.check",
  "image.ocr",
  "pdf.read",
  "dns.lookup",
  "whois.lookup",
  "fs.search",
]);

export function def(
  name: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  flags: Partial<Pick<ToolDefinition, "readOnly" | "mutates" | "askMode">> = {},
): ToolDefinition {
  const timedParameters: ToolDefinition["parameters"] = !TIMED_TOOLS.has(name)
    ? parameters
    : {
        ...parameters,
        properties: {
          ...(parameters.properties ?? {}),
          timeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: 1_800_000,
            description:
              "Wall-clock timeout in milliseconds (default 40000). You can decide how much time is enough for this task and set timeoutMs accordingly — choose a larger value when the operation is expected to take longer.",
            ...((parameters.properties?.timeoutMs as
              Record<string, unknown> | undefined) ?? {}),
          },
        },
      };
  const wireName = registerWireNamesFor(name);
  return {
    name,
    wireName,
    description,
    parameters: timedParameters,
    ...flags,
  };
}

export const emptyObject = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
  additionalProperties: false,
};
