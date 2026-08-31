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
  /**
   * Run a single DNS query without spinning up a full recon. Use for
   * narrow asks ("what's the A record for X", "find the MX for Y") so
   * the agent doesn't reach for nmap/whois when one dig is enough.
   */
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
  /**
   * Run a single whois query so callers asking about ownership/registrar
   * never trigger an nmap scan as a side effect.
   */
  async "whois.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    // Keep whois short-lived: many servers hang or buffer until close. A hard
    // 20s cap beats the outer 60s "no output" stall watchdog aborting mid-recon.
    return nativeWhoisLookup(host.value);
  },
};
