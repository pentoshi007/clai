import { getNetworkContext } from "../network-context.js";
import { pingSweep } from "../net-ping-sweep.js";
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

export const toolRegistry_NETWORK_3: Record<string, ToolHandler> = {
  async "net.context"() {
    return getNetworkContext();
  },
  async "net.pingSweep"(args, options) {
    const target = requireString(args, "target");
    return pingSweep(
      {
        target,
        method: optionalString(args, "method") as
          "auto" | "nmap" | "arp" | "native" | undefined,
        timeoutMs: optionalNumber(args, "timeoutMs"),
      },
      { signal: options?.signal },
    );
  },
};
