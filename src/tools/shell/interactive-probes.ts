const SSH_VALUE_FLAGS = new Set("BbcDEeFIiJLlmOopQRSWw");
const SCP_VALUE_FLAGS = new Set("cDFiJl oPSX".replace(/ /g, ""));

export function sshNeedsTerminal(base: string, args: readonly string[]): boolean {
  if (base === "rsync") return !args.some(arg => arg === "--version" || arg === "--help" || arg === "-V");
  const valueFlags = base === "ssh" ? SSH_VALUE_FLAGS : SCP_VALUE_FLAGS;
  let batchMode: boolean | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help") return false;
    if (!token.startsWith("-") || token === "--") break;
    for (let position = 1; position < token.length; position += 1) {
      const flag = token[position]!;
      if (flag === "V" || flag === "h") return false;
      if (base === "ssh" && (flag === "G" || flag === "Q")) return false;
      if (base === "scp" && flag === "B") batchMode ??= true;
      if (!valueFlags.has(flag)) continue;
      const value = token.slice(position + 1) || args[++index] || "";
      if (flag === "o" && batchMode === undefined) {
        const match = /^BatchMode(?:\s*=\s*|\s+)(yes|no)$/i.exec(value.trim());
        if (match) batchMode = match[1]!.toLowerCase() === "yes";
      }
      break;
    }
  }
  return batchMode !== true;
}
