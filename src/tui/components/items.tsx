import { Box, Text } from "ink";
import type {
  AssistantItem,
  NoticeItem,
  PlanItem,
  ThinkingItem,
  ToolItem,
  TranscriptItem,
  UserItem,
} from "../state.js";
import { renderMarkdown } from "../../ui/markdown.js";
import { renderPlanChecklist } from "../../ui/plan-pane.js";

const TOOL_PREVIEW_LINES = 12;

function UserMessage({ item }: { item: UserItem }) {
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color="magenta">{"❯ "}</Text>
      <Text>{item.text}</Text>
    </Box>
  );
}

function AssistantMessage({ item }: { item: AssistantItem }) {
  const rendered = renderMarkdown(item.text).replace(/\n+$/, "");
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{rendered}</Text>
      {item.streaming ? <Text color="magenta">▌</Text> : null}
    </Box>
  );
}

function ThinkingBlock({
  item,
  expanded,
}: {
  item: ThinkingItem;
  expanded: boolean;
}) {
  const lines = item.content.trim().split(/\r?\n/);
  const preview = expanded ? lines : lines.slice(0, 1);
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor italic>
        {"  ✦ thinking"}
        {expanded ? "" : lines.length > 1 ? `  (${lines.length} lines · Ctrl+T)` : ""}
      </Text>
      {preview.map((line, i) => (
        <Text key={i} dimColor>
          {"    "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

const STATUS_GLYPH: Record<ToolItem["status"], { glyph: string; color: string }> = {
  running: { glyph: "●", color: "yellow" },
  ok: { glyph: "✓", color: "green" },
  fail: { glyph: "✗", color: "red" },
  blocked: { glyph: "⊘", color: "red" },
};

function ToolCard({ item }: { item: ToolItem }) {
  const status = STATUS_GLYPH[item.status];
  const outputLines = item.output ? item.output.replace(/\n+$/, "").split("\n") : [];
  const showLines =
    item.status === "running"
      ? outputLines.slice(-TOOL_PREVIEW_LINES)
      : outputLines.slice(0, TOOL_PREVIEW_LINES);
  const hidden = outputLines.length - showLines.length;
  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={status.color}
      paddingX={1}
    >
      <Text>
        <Text color={status.color}>{status.glyph} </Text>
        <Text bold color="cyan">
          {item.name}
        </Text>
        {item.argsDisplay ? <Text dimColor> {item.argsDisplay}</Text> : null}
        {typeof item.exitCode === "number" && item.exitCode !== 0 ? (
          <Text color="red"> (exit {item.exitCode})</Text>
        ) : null}
      </Text>
      {item.status === "blocked" && item.summary ? (
        <Text color="red">{"  blocked: "}{item.summary}</Text>
      ) : null}
      {showLines.length > 0 ? (
        <Box flexDirection="column" marginTop={hidden > 0 ? 0 : 0}>
          {hidden > 0 && item.status !== "running" ? (
            <Text dimColor>{`  … ${hidden} more line(s)`}</Text>
          ) : null}
          {showLines.map((line, i) => (
            <Text key={i} dimColor>
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  const color = item.level === "warn" ? "yellow" : "gray";
  const glyph = item.level === "warn" ? "⚠" : "ℹ";
  return (
    <Box marginTop={1}>
      <Text color={color} dimColor={item.level === "info"}>
        {"  "}
        {glyph} {item.text}
      </Text>
    </Box>
  );
}

function PlanCard({ item }: { item: PlanItem }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{renderPlanChecklist(item.plan)}</Text>
    </Box>
  );
}

export function ItemView({
  item,
  thinkingExpanded,
}: {
  item: TranscriptItem;
  thinkingExpanded: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantMessage item={item} />;
    case "thinking":
      return <ThinkingBlock item={item} expanded={thinkingExpanded} />;
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return <Notice item={item} />;
    case "plan":
      return <PlanCard item={item} />;
  }
}
