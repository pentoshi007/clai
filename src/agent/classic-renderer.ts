import chalk from "chalk";
import type { AgentEvent } from "./events.js";
import { styleToolChatter } from "./runner.js";
import type { ToolCall } from "../types.js";
import { indentAndWrapText, renderMarkdown } from "../ui/markdown.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import { startThinkingSpinner, type ThinkingSpinner } from "../ui/spinner.js";
import { renderThinkingSummary } from "../ui/thinking.js";

export interface ClassicRenderer {
  onEvent: (event: AgentEvent) => void;
}

export function attachClassicRenderer(
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): ClassicRenderer {
  const toolCalls = new Map<string, ToolCall>();
  let spinner: ThinkingSpinner | undefined;

  const callFor = (id: string): ToolCall =>
    toolCalls.get(id) ?? { name: "tool", args: {} };

  const stopSpinner = (): void => {
    spinner?.stop();
    spinner = undefined;
  };

  const setSpinnerLabel = (label: string): void => {
    if (!spinner) {
      spinner = startThinkingSpinner(label);
    } else {
      spinner.setLabel(label);
    }
  };

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case "turn-start":
      case "assistant-delta":
      case "confirm-request":
        return;
      case "thinking-delta":
        setSpinnerLabel("thinking");
        spinner?.pushPreview(event.text);
        return;
      case "status":
        if (
          event.text === "waiting for model" ||
          event.text === "thinking" ||
          /^step \d+$/.test(event.text)
        ) {
          setSpinnerLabel(event.text);
          return;
        }
        stopSpinner();
        write(chalk.dim(event.text));
        return;
      case "notice": {
        stopSpinner();
        const prefix = event.level === "warn" ? "  ⚠ " : "  ℹ ";
        const color = event.level === "warn" ? chalk.yellow : chalk.dim;
        write(color(`${prefix}${event.text}\n`));
        return;
      }
      case "thinking-block":
        stopSpinner();
        write(`${renderThinkingSummary(event.content)}\n`);
        return;
      case "assistant-message": {
        stopSpinner();
        write(renderMarkdown(event.text));
        if (!event.text.endsWith("\n")) write("\n");
        return;
      }
      case "tool-call": {
        stopSpinner();
        const call: ToolCall = { name: event.name, args: {} };
        toolCalls.set(event.id, call);
        const line =
          chalk.cyan(`  ▶ ${event.name}`) + chalk.gray(` ${event.argsDisplay}`);
        write(styleToolChatter(call, line) + "\n");
        return;
      }
      case "tool-output": {
        stopSpinner();
        if (!event.chunk) return;
        if (event.chunk === "ok\n") {
          write(chalk.green("  ✓") + "\n");
          return;
        }
        if (event.chunk === "failed\n") {
          write(chalk.red("  ✗") + "\n");
          return;
        }
        const call = callFor(event.id);
        const body = event.chunk.startsWith("\n")
          ? event.chunk
          : indentAndWrapText(event.chunk);
        write(styleToolChatter(call, body.endsWith("\n") ? body : `${body}\n`));
        return;
      }
      case "tool-result":
        return;
      case "tool-blocked":
        stopSpinner();
        write(chalk.red(`  ✗ blocked: ${event.reason}`) + "\n");
        return;
      case "plan-update":
        stopSpinner();
        if (event.plan.status === "draft") {
          write(
            chalk.cyan("  ● planning\n") +
              renderPlanChecklist(event.plan) +
              "\n" +
              chalk.dim(
                "  ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,\n" +
                  "    or /discard to cancel it. Any other message refines this plan.\n",
              ),
          );
        } else {
          write(renderPlanChecklist(event.plan) + "\n");
        }
        return;
      case "turn-end":
        stopSpinner();
        return;
      case "turn-aborted":
        stopSpinner();
        write(chalk.yellow("  ⏹ Aborted.\n"));
        return;
      case "turn-error":
        stopSpinner();
        write(chalk.red(`  ✗ ${event.message}\n`));
        return;
    }
  };

  return { onEvent };
}
