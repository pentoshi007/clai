import { responderJobOptions } from "./responder-job-options.js";
import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  normalizeScanProfile,
  profileToNmapArgs,
} from "../validate.js";
import { jobManager, type StartJobOptions } from "../jobs.js";
import { resolveNmapTimeoutPolicy, runNmapScan } from "../nmap-runner.js";
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
import {
  buildPentestReconNmapArgv,
  prepareDurableNmapJob,
} from "./nmap-preparation.js";
import { estimateScanResources } from "../registry.js";

export const toolRegistry_NETWORK_1: Record<string, ToolHandler> = {
  async "net.scan"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const portsRaw = optionalString(args, "ports");
    // Accept natural "top ports" intents (top-1000, top1000, top-ports 1000,
    // "top 1000") as a topPorts profile instead of rejecting them as an
    // invalid literal port spec.
    const topPortsMatch = portsRaw
      ? /^top[\s_-]*(?:ports?[\s_-]*)?(\d{1,5})$/i.exec(portsRaw.trim())
      : null;
    const ports =
      portsRaw && !topPortsMatch ? parsePortSpec(portsRaw) : undefined;
    let profile = normalizeScanProfile(args.profile);
    if (topPortsMatch) {
      const n = Math.max(1, Math.min(65535, Number(topPortsMatch[1])));
      profile = { ...(profile ?? {}), topPorts: profile?.topPorts ?? n };
    }

    const legacyFlags = optionalString(args, "flags");
    // ports and topPorts conflict on the nmap CLI — ports takes priority
    const cleanedProfile =
      ports && profile?.topPorts
        ? { ...profile, topPorts: undefined }
        : profile;
    const profileArgs = profileToNmapArgs(cleanedProfile);
    const legacyArgs = legacyFlags ? parseLegacyFlags(legacyFlags) : [];
    const argv: string[] = [];
    if (ports) argv.push("-p", ports);
    argv.push(...profileArgs, ...legacyArgs, host.value);
    const estimate = estimateScanResources(argv);
    const durable = args.background === true || args.responder === true;
    if (durable) {
      const prepared = await prepareDurableNmapJob(
        argv,
        options,
        "Enter your password for the nmap raw-socket scan. It is sent only to sudo stdin and is never stored. Esc cancels.",
      );
      if (!prepared.prepared) return prepared.result;
      return jobManager.startJob(prepared.spec, {
        name: `nmap-${estimate.profile}-${host.value}`,
        profile: estimate.profile,
        estimatedSeconds: estimate.estimatedSeconds,
        ...responderJobOptions(options),
        responder: args.responder === true,
        wakeOnCompletion: args.responder === true,
        ...(options?.engagementAuthorization
          ? { authorization: options.engagementAuthorization }
          : {}),
      });
    }
    return runNmapScan(argv, options, optionalNumber(args, "timeoutMs"));
  },
};
