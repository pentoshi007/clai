import { safeCwd } from "../../os/cwd.js";
import type { ToolResult } from "../../types.js";
import { ensureReadAllowed, resolveReadPath } from "./internals.js";
import { execa } from "execa";

export async function fsSearch(
  pattern: string,
  path = safeCwd(),
  options: {
    confirmed?: boolean | undefined;
    maxMatches?: number | undefined;
    maxPerFile?: number | undefined;
    glob?: string | undefined;
    caseInsensitive?: boolean | undefined;
    fixedString?: boolean | undefined;
    context?: number | undefined;
    filesOnly?: boolean | undefined;
    hidden?: boolean | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = resolveReadPath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxMatches = Math.min(
    200,
    Math.max(1, Math.floor(options.maxMatches ?? 50)),
  );
  const maxPerFile = Math.min(
    200,
    Math.max(1, Math.floor(options.maxPerFile ?? 20)),
  );
  const context = Math.min(10, Math.max(0, Math.floor(options.context ?? 0)));
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, Math.floor(options.timeoutMs ?? 15_000)),
  );
  if (!pattern.trim()) {
    return {
      ok: false,
      output: 'fs.search requires a non-empty "pattern"',
      exitCode: 1,
    };
  }

  try {
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(maxPerFile),
      "--max-filesize",
      "1M",
      "--max-columns",
      "300",
      "--max-columns-preview",
    ];
    if (options.caseInsensitive) rgArgs.push("-i");
    if (options.fixedString) rgArgs.push("-F");
    if (options.hidden) rgArgs.push("--hidden");
    if (options.filesOnly) rgArgs.push("-l");
    if (context > 0) rgArgs.push("-C", String(context));
    if (options.glob) rgArgs.push("-g", options.glob);
    rgArgs.push("--", pattern, resolved);
    const result = await execa("rg", rgArgs, {
      reject: false,
      all: true,
      timeout: timeoutMs,
    });
    if (result.exitCode === 0 || result.exitCode === 1) {
      const body = (result.all ?? "").trim();
      if (!body) {
        return {
          ok: true,
          output: `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n# no matches`,
          exitCode: 0,
        };
      }
      const allLines = body.split("\n").filter(Boolean);
      const lines = allLines.slice(0, maxMatches);
      const truncated = allLines.length > maxMatches;
      return {
        ok: true,
        output:
          `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved} hits=${lines.length}` +
          (truncated ? ` (capped at ${maxMatches})` : "") +
          `\n# tip: fs.read path=… offset=<line> limit=… or pattern= for a focused window\n` +
          lines.join("\n"),
        exitCode: 0,
        truncated,
      };
    }
  } catch {
  }

  try {
    const grepArgs = ["-R", "-n", "-I", "-m", String(maxPerFile)];
    if (options.caseInsensitive) grepArgs.push("-i");
    if (options.fixedString) grepArgs.push("-F");
    if (options.filesOnly) grepArgs.push("-l");
    if (context > 0) grepArgs.push("-C", String(context));
    if (options.glob) grepArgs.push(`--include=${options.glob}`);
    grepArgs.push("--", pattern, resolved);
    const result = await execa("grep", grepArgs, {
      reject: false,
      all: true,
      timeout: timeoutMs,
    });
    const body = (result.all ?? "").trim();
    if (!body || result.exitCode === 1) {
      return {
        ok: true,
        output: `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n# no matches`,
        exitCode: 0,
      };
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return {
        ok: false,
        output: body || `fs.search failed (exit ${result.exitCode})`,
        exitCode: result.exitCode ?? 1,
      };
    }
    return {
      ok: true,
      output:
        `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n` +
        `# tip: fs.read path=… offset=<line> limit=… for a focused window\n` +
        body,
      exitCode: 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `fs.search failed (need ripgrep or grep): ${msg}`,
      exitCode: 1,
    };
  }
}
