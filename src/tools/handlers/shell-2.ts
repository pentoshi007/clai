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
    // Skip the install entirely if the tool is already on PATH. The executable
    // a package provides isn't always its package name (ripgrep→rg,
    // dnsutils→dig), so check the known binary alias too. This makes the
    // model's "check-then-install" intent cheap and idempotent.
    const checkArg = optionalString(args, "checkBinary");
    const binary = checkArg ?? packageBinaryName(tool);
    // dig/whois are never required — built-in dns.lookup / whois.lookup cover them.
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
      // Unknown manager: fall back to an instructional message instead of
      // executing a malformed shell string.
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
