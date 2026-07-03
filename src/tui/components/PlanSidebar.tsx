import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { SessionPlan, TaskState } from "../../store/plan.js";
import { wrapAnsiLine } from "../../ui/markdown.js";

const taskGlyph: Record<TaskState, string> = {
  pending: "○",
  in_progress: "◆",
  done: "✓",
  failed: "!",
  skipped: "–",
};

const taskColor: Record<TaskState, string> = {
  pending: "gray",
  in_progress: "cyan",
  done: "green",
  failed: "red",
  skipped: "gray",
};

export function PlanSidebar({
  plan,
  width,
  height,
}: {
  plan: SessionPlan;
  width: number;
  height: number;
}) {
  const done = plan.tasks.filter((task) => task.state === "done").length;
  const percent = plan.tasks.length
    ? Math.round((done / plan.tasks.length) * 100)
    : 0;
  const contentWidth = Math.max(8, width - 4);

  const rowHeight = (index: number) => {
    const task = plan.tasks[index]!;
    const prefix = `${taskGlyph[task.state]} ${index + 1}. `;
    const prefixWidth = stringWidth(prefix);
    const textWidth = Math.max(4, contentWidth - prefixWidth);
    const fullText = `${task.title}${task.note ? ` — ${task.note}` : ""}`;
    return Math.max(1, wrapAnsiLine(fullText, textWidth).length);
  };

  const focus = Math.max(
    0,
    plan.tasks.findIndex((task) => task.state === "in_progress") >= 0
      ? plan.tasks.findIndex((task) => task.state === "in_progress")
      : plan.tasks.findIndex((task) => task.state === "pending"),
  );

  const headerLines = wrapAnsiLine(plan.goal, contentWidth).length;
  const nonTaskHeight = 2 + 1 + headerLines + 1 + 1 + 1;
  const tasksSectionBudget = Math.max(1, height - nonTaskHeight);

  const getSliceHeight = (startIdx: number, endIdx: number) => {
    let h = 0;
    if (startIdx > 0) h += 1;
    for (let i = startIdx; i <= endIdx; i++) {
      h += rowHeight(i);
    }
    if (endIdx < plan.tasks.length - 1) h += 1;
    return h;
  };

  let start = focus;
  let end = focus;

  if (plan.tasks.length > 0) {
    let currentHeight = getSliceHeight(start, end);
    while (true) {
      let expanded = false;
      if (end < plan.tasks.length - 1) {
        const nextHeight = getSliceHeight(start, end + 1);
        if (nextHeight <= tasksSectionBudget) {
          end += 1;
          currentHeight = nextHeight;
          expanded = true;
        }
      }
      if (start > 0) {
        const nextHeight = getSliceHeight(start - 1, end);
        if (nextHeight <= tasksSectionBudget) {
          start -= 1;
          currentHeight = nextHeight;
          expanded = true;
        }
      }
      if (!expanded) break;
    }
  }

  const visible: Array<{ task: SessionPlan["tasks"][number]; index: number }> = [];
  if (plan.tasks.length > 0) {
    for (let index = start; index <= end; index++) {
      visible.push({ task: plan.tasks[index]!, index });
    }
  }

  const hiddenBelow = visible.length
    ? plan.tasks.length - visible[visible.length - 1]!.index - 1
    : 0;

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color="cyan">● LIVE PLAN VIEW</Text>
      <Box width={contentWidth}>
        <Text bold wrap="wrap">{plan.goal}</Text>
      </Box>
      <Box width={contentWidth}>
        <Text dimColor wrap="wrap">
          {plan.status.replace("_", " ")} · {done}/{plan.tasks.length} · {percent}%
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column" width={contentWidth}>
        {start > 0 ? (
          <Box width={contentWidth}>
            <Text dimColor>↑ {start} earlier task{start === 1 ? "" : "s"}</Text>
          </Box>
        ) : null}
        {visible.map(({ task, index }) => {
          const prefix = `${taskGlyph[task.state]} ${index + 1}. `;
          const prefixWidth = stringWidth(prefix);
          const textWidth = Math.max(4, contentWidth - prefixWidth);
          const fullText = `${task.title}${task.note ? ` — ${task.note}` : ""}`;
          const textLines = wrapAnsiLine(fullText, textWidth);

          return (
            <Box key={task.id} flexDirection="column" width={contentWidth}>
              {textLines.map((line, lineIdx) => {
                const isFirst = lineIdx === 0;
                return (
                  <Box key={lineIdx} flexDirection="row" width={contentWidth}>
                    {isFirst ? (
                      <Text color={taskColor[task.state]} bold={task.state === "in_progress"}>
                        {prefix}
                      </Text>
                    ) : (
                      <Text>
                        {" ".repeat(prefixWidth)}
                      </Text>
                    )}
                    <Text
                      color={taskColor[task.state]}
                      dimColor={task.state === "done" || task.state === "skipped"}
                      bold={task.state === "in_progress"}
                    >
                      {line}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })}
        {hiddenBelow > 0 ? (
          <Box width={contentWidth}>
            <Text dimColor>↓ {hiddenBelow} more task{hiddenBelow === 1 ? "" : "s"}</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexGrow={1} />
      <Box width={contentWidth}>
        <Text dimColor wrap="wrap">
          {plan.status === "draft"
            ? "/implement to approve · Ctrl+H to hide"
            : "Ctrl+H to hide · Ctrl+P for details"}
        </Text>
      </Box>
    </Box>
  );
}
