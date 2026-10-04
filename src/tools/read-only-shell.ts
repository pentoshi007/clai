import type { ToolCall } from "../types.js";
import { permissionShellSyntax } from "../safety/shell-permission-words.js";

const INSPECTION_COMMANDS = new Set([
  "rg", "grep", "egrep", "fgrep", "ls", "dir", "find", "locate",
  "which", "where", "whereis", "pwd", "cat", "head", "tail", "wc",
  "sort", "uniq", "cut", "tr", "stat", "file", "tree", "du", "df",
  "get-childitem", "get-command", "get-content", "select-string",
  "select-object", "sort-object", "measure-object",
]);

export function isReadOnlyShellCall(call: ToolCall): boolean {
  if (call.name !== "shell.exec" || call.args.background === "always" || call.args.responder === true) return false;
  const command = typeof call.args.command === "string" ? call.args.command.trim() : "";
  if (!command) return false;
  const unquoted = command.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g, "");
  if (/(?:^|[^&])&(?:[^&]|$)/.test(unquoted)) return false;
  const syntax = permissionShellSyntax(command);
  if (syntax.uncertain || syntax.segments.length === 0) return false;
  return syntax.segments.every(({ words }) => {
    if (words.some((word) => word.dynamic || word.operator)) return false;
    const name = words[0]?.value.toLowerCase().replace(/\.exe$/, "");
    if (!name) return false;
    const args = words.slice(1).map((word) => word.value);
    if (name === "command") return args[0] === "-v" && args.length > 1;
    if (!INSPECTION_COMMANDS.has(name)) return false;
    const terminator = args.indexOf("--");
    const flags = terminator < 0 ? args : args.slice(0, terminator);
    if (name === "rg" && flags.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) return false;
    if (name === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(arg))) return false;
    if ((name === "sort" || name === "tree") && flags.some((arg) => /^-[^-]*o|^--(?:output|compress-program)(?:=|$)/.test(arg))) return false;
    if (name === "sort" && flags.some((arg) => /^\/o/i.test(arg))) return false;
    if (name === "file" && flags.some((arg) => /^-[^-]*C|^--compile(?:=|$)/.test(arg))) return false;
    if (name === "uniq") {
      let operands = 0;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--" && i === terminator) continue;
        if (terminator < 0 || i < terminator) {
          if (/^-(?:f|s|w)$|^--(?:skip-fields|skip-chars|check-chars)$/.test(arg)) { i++; continue; }
          if (arg.startsWith("-")) continue;
        }
        if (++operands > 1) return false;
      }
    }
    return true;
  });
}
