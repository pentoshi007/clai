import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ChromeLayout } from "./row-budget.js";

export type ChromeSectionKey = keyof Pick<
  ChromeLayout,
  "liveTail" | "plan" | "overlay" | "queue" | "responder" | "toast" | "composer" | "status"
>;

const SECTIONS: readonly { readonly key: ChromeSectionKey; readonly label: string }[] = [
  { key: "toast", label: "toast" },
  { key: "liveTail", label: "live" },
  { key: "plan", label: "plan" },
  { key: "overlay", label: "overlay" },
  { key: "queue", label: "queue" },
  { key: "responder", label: "responder" },
  { key: "composer", label: "composer" },
  { key: "status", label: "status" },
];

export type ChromeContent = Partial<Record<ChromeSectionKey, readonly string[]>>;

export type ChromeSlots = Partial<Record<ChromeSectionKey, ReactNode>>;

function sectionLines(
  label: string,
  rows: number,
  columns: number,
  content: readonly string[] | undefined,
): string[] {
  const width = Math.max(1, Math.floor(columns));
  return Array.from({ length: rows }, (_, index) =>
    content?.[index] ?? `${label} ${index + 1}/${rows}`,
  ).map((line) => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line));
}

export function ChromeSection(props: {
  readonly label: string;
  readonly rows: number;
  readonly columns: number;
  readonly content?: readonly string[] | undefined;
}): ReactNode {
  return (
    <Box flexDirection="column" height={props.rows} flexShrink={0}>
      {sectionLines(props.label, props.rows, props.columns, props.content).map(
        (line, index) => (
          <Text key={`${props.label}-${index}`} dimColor>
            {line}
          </Text>
        ),
      )}
    </Box>
  );
}

export function Chrome(props: {
  readonly layout: ChromeLayout;
  readonly columns: number;
  readonly content?: ChromeContent | undefined;
  readonly liveTail?: ReactNode | undefined;
  readonly slots?: ChromeSlots | undefined;
}): ReactNode {
  const slots: ChromeSlots = { liveTail: props.liveTail, ...props.slots };
  return (
    <Box flexDirection="column">
      {SECTIONS.filter(({ key }) => props.layout[key] > 0).map(({ key, label }) => {
        const slot = slots[key];
        if (slot !== undefined && slot !== null) {
          return (
            <Box key={key} flexDirection="column" flexShrink={0}>
              {slot}
            </Box>
          );
        }
        return (
          <ChromeSection
            key={key}
            label={label}
            rows={props.layout[key]}
            columns={props.columns}
            content={props.content?.[key]}
          />
        );
      })}
    </Box>
  );
}
