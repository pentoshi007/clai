import { join } from "node:path";
import { formatRuntimeError } from "../../os/runtime-error.js";
import { writeTerminalAndWait } from "../../os/terminal-write.js";
import { getLogsDirRoot } from "../../store/paths.js";

export async function reportFatalError(
  error: unknown,
  write: (text: string) => void | Promise<void> = (text) => writeTerminalAndWait(text, process.stderr),
): Promise<void> {
  const logPath = join(getLogsDirRoot(), "tui-console.log");
  await write(`\nclai stopped: ${formatRuntimeError(error)}\nDiagnostic log (if available): ${logPath}\n`);
}
