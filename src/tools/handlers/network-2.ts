import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  normalizeScanProfile,
  profileToNmapArgs,
} from "../validate.js";
import { nativeDnsLookup } from "../dns-native.js";
import { nativeWhoisLookup } from "../whois-native.js";
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

export const toolRegistry_NETWORK_2: Record<string, ToolHandler> = {
  async "dns.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const recordRaw = (optionalString(args, "record") ?? "A").toUpperCase();
    const allowed = new Set([
      "A",
      "AAAA",
      "ANY",
      "CAA",
      "CNAME",
      "MX",
      "NS",
      "PTR",
      "SOA",
      "SRV",
      "TXT",
    ]);
    if (!allowed.has(recordRaw)) {
      throw new Error(
        `dns.lookup: unsupported record type "${recordRaw}". Allowed: ${[...allowed].join(", ")}`,
      );
    }
    return nativeDnsLookup(
      host.value,
      recordRaw as Parameters<typeof nativeDnsLookup>[1],
    );
  },
  async "whois.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    return nativeWhoisLookup(host.value);
  },
};
