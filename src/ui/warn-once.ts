import chalk from "chalk";

const seen = new Set<string>();

export function warnOnce(message: string): void {
  const line = message.replace(/\s+/g, " ").trim();
  if (!line || seen.has(line)) return;
  seen.add(line);
  console.error(chalk.dim(`  ${line}`));
}

export function resetWarnOnce(): void {
  seen.clear();
}
