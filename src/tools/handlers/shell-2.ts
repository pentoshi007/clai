import {
  detectPackageManager,
  assertSafePackageName,
  commandAvailable,
} from "../../os/pkgmgr.js";
import { shellExec, spawnArgv } from "../shell.js";
import { resolveShellExecBackgroundPolicy } from "../command-intent.js";
import { packageBinaryName } from "../package-binary.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import { fromWireName, sanitizeToolName } from "../../llm/tool-protocol.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
} from "./args.js";

export const toolRegistry_SHELL_2: Record<string, ToolHandler> = {
  async "pkg.install"(args, options) {
    const tool = assertSafePackageName(requireString(args, "tool"));
    const checkArg = optionalString(args, "checkBinary");
    const binary = checkArg ?? packageBinaryName(tool);
    const nativeCovered = new Set([
      "dig",
      "whois",
      "bind",
      "bind9",
      "dnsutils",
      "bind-utils",
      "nslookup",
    ]);
    if (
      nativeCovered.has(tool.toLowerCase()) ||
      nativeCovered.has(binary.toLowerCase())
    ) {
      return {
        ok: true,
        output:
          `${tool} is optional. Use built-in dns.lookup (Node resolver + DNS-over-HTTPS) ` +
          `and whois.lookup (RDAP + port-43) — no system binary install required.`,
        exitCode: 0,
      };
    }
    if (await commandAvailable(binary)) {
      return {
        ok: true,
        output: `${binary} is already installed and on PATH — skipping install.`,
        exitCode: 0,
      };
    }
    const pkgmgr = await detectPackageManager();
    const spec = pkgmgr.installArgv(tool);
    if (!spec) {
      return { ok: false, output: pkgmgr.installCommand(tool), exitCode: 1 };
    }
    return spawnArgv({
      command: spec.command,
      argv: spec.argv,
      timeoutMs: optionalNumber(args, "timeoutMs") ?? 600_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
};
