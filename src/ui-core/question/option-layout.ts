import { wrapPagerLine } from "../rendering/pager-chrome.js";
import { renderColumns } from "../rendering/text-width.js";

export interface QuestionOptionLine {
  readonly label: string;
  readonly description: string;
}

export interface QuestionOptionLayoutInput {
  readonly prefix: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly width: number;
}

const DESCRIPTION_SEPARATOR = " — ";

const wrapText = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => wrapPagerLine(line, width));

export function questionOptionLines(input: QuestionOptionLayoutInput): QuestionOptionLine[] {
  const width = Math.max(1, input.width);
  const head = `${input.prefix}${input.label}`;
  const description = input.description ?? "";
  const inline = description ? `${DESCRIPTION_SEPARATOR}${description}` : "";
  if (renderColumns(head) + renderColumns(inline) <= width) return [{ label: head, description: inline }];
  const indent = " ".repeat(Math.min(renderColumns(input.prefix), width - 1));
  const room = Math.max(1, width - indent.length);
  const labelLines = wrapText(input.label, room).map((line, index) => ({
    label: `${index === 0 ? input.prefix : indent}${line}`,
    description: "",
  }));
  const descriptionLines = description
    ? wrapText(description, room).map((line) => ({ label: indent, description: line }))
    : [];
  return [...labelLines, ...descriptionLines];
}
