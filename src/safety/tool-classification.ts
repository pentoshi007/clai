import { findExecutableSync } from "../os/command.js";
import { externalToolRisk } from "../tools/external-tools.js";
import { packageBinaryName } from "../tools/package-binary.js";
import { classifyHost } from "../tools/web/ssrf-guard.js";
import type { ToolCall } from "../types.js";
import { classifyInteractiveInput, ClassifyOptions, classifyShellCommand, RiskDecision } from "./shell-classification.js";

/**
 * Plain executable name: letters, digits and the punctuation real binaries
 * use. Anything with a path separator, whitespace, or a shell metacharacter
 * is rejected outright — classification must never interpret model text.
 */
const PLAIN_BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Side-effect-free PATH probe. No shell, no child process: `findExecutableSync`
 * only stats candidate paths, so a model-supplied `checkBinary` can never be
 * interpreted as a command during safety classification.
 */
function isBinaryOnPath(binary: string): boolean {
  if (!PLAIN_BINARY_NAME_RE.test(binary)) return false;
  return Boolean(findExecutableSync(binary));
}

export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function classifyToolCall(
  call: ToolCall,
  options: ClassifyOptions = {},
): RiskDecision {
  const external = externalToolRisk(call.name);
  if (external) return external;

  if (
    call.name === "fs.read" ||
    call.name === "fs.list" ||
    call.name === "fs.search" ||
    call.name === "mcp.list" ||
    call.name === "mcp.tools"
  ) {
    return { level: "safe", reason: "Read-only operation" };
  }

  if (call.name === "sysinfo") {
    return { level: "safe", reason: "Read-only operation" };
  }

  if (call.name === "skill.load" || call.name === "skill.list") {
    return { level: "safe", reason: "Read-only Agent Skill lookup" };
  }

  if (call.name === "instructions.record") {
    return {
      level: "safe",
      reason: "Records standing instructions in .clai/INSTRUCTIONS.md",
    };
  }

  if (call.name === "dns.lookup" || call.name === "whois.lookup") {
    // Single-shot DNS / whois queries are passive lookups. They never
    // touch the target's network stack, so we don't gate them behind
    // pentest authorization or scope confirmation. The underlying
    // spawnArgv call still validates the target via parseHost.
    return {
      level: "safe",
      reason: "Passive lookup against public registries",
    };
  }

  if (call.name === "tool.batch") {
    // Inspect children: all-safe batches stay auto-run; any confirm-level
    // child elevates the whole batch so shell/fs mutates cannot hide behind
    // a "safe batch" label. Block-level children block the batch. Nested
    // tool.batch / plan tools are rejected in the handler.
    const rawCalls = call.args?.calls;
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      return { level: "safe", reason: "Empty or invalid batch (handler will reject)" };
    }
    let elevates = false;
    for (const entry of rawCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const childName =
        typeof (entry as { name?: unknown }).name === "string"
          ? String((entry as { name: string }).name).trim()
          : "";
      if (!childName) continue;
      // Wire form (tool_check) → canonical (tool.check) for classification.
      const dotted = childName.includes(".")
        ? childName
        : childName.includes("_")
          ? childName.replace(/_/g, ".")
          : childName;
      // Nested batches would recurse forever and are forbidden in the handler.
      if (dotted === "tool.batch") {
        return {
          level: "block",
          reason: "Nested tool.batch is not allowed",
        };
      }
      const childArgs =
        typeof (entry as { args?: unknown }).args === "object" &&
        (entry as { args?: unknown }).args !== null &&
        !Array.isArray((entry as { args?: unknown }).args)
          ? ((entry as { args: Record<string, unknown> }).args)
          : {};
      const child = classifyToolCall(
        { name: dotted, args: childArgs },
        options,
      );
      if (child.level === "block") {
        return {
          level: "block",
          reason: `Batch child ${dotted}: ${child.reason}`,
        };
      }
      if (child.level === "confirm") elevates = true;
    }
    if (elevates) {
      return {
        level: "confirm",
        reason: "Batch includes tools that require confirmation",
      };
    }
    return { level: "safe", reason: "Batch of read-only / auto-safe tools" };
  }

  if (call.name === "http.fetch") {
    return {
      level: "safe",
      reason:
        "HTTP fetch is a network request, not a local filesystem mutation",
    };
  }

  if (call.name === "shell.exec") {
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
  }

  if (call.name === "terminal.start") {
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
  }

  if (call.name === "terminal.send") {
    const kind = stringArg(call.args, "kind");
    if (kind === "text") {
      return classifyInteractiveInput({
        ownerId: "tool",
        sessionId: stringArg(call.args, "id") ?? "unknown",
        transport: "pipe",
        input: {
          kind: "text",
          text: stringArg(call.args, "text") ?? "",
          submit: call.args.submit === "none" ? "none" : "enter",
        },
        ...(options.scope ? { scope: options.scope } : {}),
      });
    }
    return { level: "safe", reason: "Terminal control input" };
  }

  if (
    call.name === "terminal.read" ||
    call.name === "terminal.status" ||
    call.name === "terminal.list" ||
    call.name === "terminal.resize" ||
    call.name === "terminal.close"
  ) {
    return { level: "safe", reason: "Interactive session management" };
  }

  if (call.name === "net.scan") {
    return { level: "safe", reason: "Read-only network scan" };
  }

  if (call.name === "pentest.recon") {
    return { level: "safe", reason: "Read-only pentest recon" };
  }

  if (
    call.name === "fs.write" ||
    call.name === "mcp.enable" ||
    call.name === "mcp.connect" ||
    call.name === "mcp.login"
  ) {
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  if (call.name === "pkg.install") {
    // pkg.install already no-ops when the binary is on PATH — checking
    // "is X installed" this way is a read, not a mutation. Probe the same
    // way the tool itself will, so that check-then-skip never prompts; only
    // an actual install (binary genuinely missing) requires confirmation.
    const tool = stringArg(call.args, "tool");
    const checkBinary = stringArg(call.args, "checkBinary");
    if (tool) {
      const binary = checkBinary ?? packageBinaryName(tool);
      if (isBinaryOnPath(binary)) {
        return {
          level: "safe",
          reason: `${binary} is already installed — pkg.install will no-op`,
        };
      }
    }
    return {
      level: "confirm",
      reason: "Package install requires confirmation",
    };
  }

  if (call.name === "fs.writeMany") {
    return {
      level: "confirm",
      reason: "Mutating operation requires confirmation",
    };
  }

  // New tools

  if (call.name === "net.context") {
    return { level: "safe", reason: "Read-only local network info" };
  }

  if (call.name === "tool.check") {
    return { level: "safe", reason: "Read-only tool availability check" };
  }

  if (call.name === "wordlist.find") {
    return { level: "safe", reason: "Read-only local wordlist lookup" };
  }

  if (call.name === "image.ocr") {
    return { level: "safe", reason: "Read-only local image OCR" };
  }

  if (call.name === "image.view") {
    return { level: "safe", reason: "Read-only local image read" };
  }

  if (call.name === "pdf.read") {
    return {
      level: "safe",
      reason: "Read-only local PDF text extraction (with OCR fallback)",
    };
  }

  if (call.name === "net.pingSweep") {
    return {
      level: "safe",
      reason: "Read-only local network sweep",
    };
  }

  if (call.name === "shell.start") {
    // Starting a background program/service should be as frictionless as
    // running it inline — classify by the command itself (a destructive or
    // mutating background command still confirms).
    const command = stringArg(call.args, "command") ?? "";
    return classifyShellCommand(command, options);
  }

  if (
    call.name === "shell.jobs" ||
    call.name === "shell.tail" ||
    call.name === "shell.wait" ||
    call.name === "shell.stop"
  ) {
    return { level: "safe", reason: "Read-only job management" };
  }

  if (
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.append"
  ) {
    return {
      level: "confirm",
      reason: "File edit requires confirmation",
    };
  }

  if (call.name === "fs.delete") {
    return {
      level: "confirm",
      reason:
        "File deletion requires manual confirmation (never auto-confirmed, even under allow-all)",
    };
  }

  if (call.name === "web.search") {
    const query = stringArg(call.args, "query") ?? "";
    if (query.length === 0 || query.length > 2048) {
      return {
        level: "block",
        reason: "web.search query length out of bounds (must be 1..2048 chars)",
      };
    }
    return { level: "safe", reason: "Public search engine query" };
  }

  if (call.name === "web.fetch") {
    const url = stringArg(call.args, "url") ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        level: "block",
        reason: "web.fetch url is not parseable",
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        level: "block",
        reason: `web.fetch refuses scheme ${parsed.protocol}`,
      };
    }
    // Strip surrounding `[]` from IPv6 hostname literals before classifying.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const blocked = classifyHost(hostname);
    if (blocked) {
      return {
        level: "block",
        reason: `web.fetch refuses ${blocked.class} address ${parsed.hostname}`,
      };
    }
    return { level: "safe", reason: "Public web read" };
  }

  return { level: "confirm", reason: "Unknown tool requires confirmation" };
}
