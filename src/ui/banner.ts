import chalk from "chalk";
import { box } from "./ansi-box.js";

export function renderModeSwitch(mode: string): string {
  return box(
    [`${chalk.dim("mode →")} ${chalk.yellow(mode)}`],
    { minWidth: 30 },
  );
}

export function renderProviderSwitch(provider: string, model: string): string {
  return box(
    [
      `${chalk.dim("provider →")} ${chalk.green(provider)}`,
      `${chalk.dim("model →")}    ${chalk.cyan(model)}`,
    ],
    { minWidth: 30 },
  );
}

export const PROMPT = `  ${chalk.magenta("❯")} `;
