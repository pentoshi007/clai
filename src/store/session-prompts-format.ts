import type { SessionPromptInput } from "./session-prompts.js";
import { sanitizeDisplayText } from "../ui-core/rendering/sanitize-display.js";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", timeZoneName: "short",
});

function code(value: string | undefined): string {
  return `\`${sanitizeDisplayText(value ?? "unknown").replace(/[`\r\n]/g, " ").slice(0, 256)}\``;
}

export function formatPromptSection(sessionId: string, number: number, input: SessionPromptInput): string {
  const timestamp = input.timestamp !== undefined && Number.isFinite(input.timestamp)
    ? dateFormat.format(input.timestamp)
    : input.imported ? "unknown · imported from saved history" : "unknown";
  const content = sanitizeDisplayText(input.content.replace(/\r\n?/g, "\n"));
  const intro = number === 1 ? [
    "# Session prompts", "", `Session ${code(sessionId)}`, "",
    "User prompts in submission order. Routes and effort reflect the settings when sent.", "",
  ].join("\n") : "";
  return [
    intro,
    "---", "", `## Prompt ${String(number).padStart(3, "0")}`, "",
    `**Sent** · ${timestamp}`,
    `**Provider** · ${code(input.provider)}`,
    `**Model** · ${code(input.model)}`,
    `**Effort** · ${code(input.effort)}`, "",
    `> ${content.replace(/\n/g, "\n> ")}`, "",
  ].join("\n");
}
