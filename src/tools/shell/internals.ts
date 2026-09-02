import { redactSecrets } from "../../llm/provider.js";
import { finalPipelineStageName, MAX_REDACT_IN_MEMORY_BYTES, NO_MATCH_EXIT_COMMANDS } from "./internals-2.js";
import { readFile, stat, writeFile } from "node:fs/promises";

export const DEFAULT_TIMEOUT_MS = 40_000;

export function launchErrorOutput(
  error: NodeJS.ErrnoException,
  details: { shell: string; cwd: string },
): string {
  const code = error.code ?? "UNKNOWN";
  const fields = [
    `shell=${JSON.stringify(details.shell)}`,
    `cwd=${JSON.stringify(details.cwd)}`,
    error.syscall ? `syscall=${JSON.stringify(error.syscall)}` : undefined,
    error.path ? `path=${JSON.stringify(error.path)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return (
    `Command launch error [${code}]: ${error.message}\n` +
    `${fields.join("; ")}\n` +
    "The command did not start. Do not rewrite its syntax to work around this infrastructure error; verify the shell and cwd, then retry at most once."
  );
}

export function assignAllowInteractiveStdinInherit(value: boolean): void {
  allowInteractiveStdinInherit = value;
}

export let allowInteractiveStdinInherit = false;

export function binarySuppressionNotice(
  bytes: number,
  artifactPath: string | undefined,
): string {
  return (
    `[binary output suppressed: ${bytes.toLocaleString()} bytes]` +
    (artifactPath
      ? `\nFull bytes were captured to ${artifactPath}. Use a text-producing command (xxd/strings/file) if you need to inspect them.`
      : "\nUse a text-producing command (xxd/strings/file) if you need to inspect the bytes.")
  );
}

export async function redactArtifactInPlace(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (st.size > MAX_REDACT_IN_MEMORY_BYTES) return false;
    const raw = await readFile(path, "utf8");
    const redacted = redactSecrets(raw);
    if (redacted === raw) return false;
    await writeFile(path, redacted, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function benignNoMatchTool(
  command: string,
  code: number | null,
): string | undefined {
  if (code !== 1) return undefined;
  const name = finalPipelineStageName(command);
  return name !== undefined && NO_MATCH_EXIT_COMMANDS.has(name)
    ? name
    : undefined;
}
