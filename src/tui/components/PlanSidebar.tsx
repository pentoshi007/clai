import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { SessionPlan, TaskState } from "../../store/plan.js";

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
    const text = `${task.title}${task.note ? ` — ${task.note}` : ""}`;
    return Math.max(1, Math.ceil((stringWidth(prefix) + stringWidth(text)) / contentWidth));
  };
  // Header/footer/borders consume seven lines. Fit whole wrapped task rows in
  // the remainder and keep the active (or first unfinished) task in view.
  const taskBudget = Math.max(1, height - 7);
  const focus = Math.max(
    0,
    plan.tasks.findIndex((task) => task.state === "in_progress") >= 0
      ? plan.tasks.findIndex((task) => task.state === "in_progress")
      : plan.tasks.findIndex((task) => task.state === "pending"),
  );
  let start = Math.min(focus, Math.max(0, plan.tasks.length - 1));
  let used = 0;
  while (start > 0 && used + rowHeight(start - 1) <= Math.floor(taskBudget / 3)) {
    start -= 1;
    used += rowHeight(start);
  }
  const visible: Array<{ task: SessionPlan["tasks"][number]; index: number }> = [];
  used = start > 0 ? 1 : 0;
  for (let index = start; index < plan.tasks.length; index += 1) {
    const reserveBottom = index < plan.tasks.length - 1 ? 1 : 0;
    const needed = rowHeight(index);
    if (visible.length > 0 && used + needed + reserveBottom > taskBudget) break;
    visible.push({ task: plan.tasks[index]!, index });
    used += needed;
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
      <Text bold wrap="wrap">{plan.goal}</Text>
      <Text dimColor wrap="wrap">
        {plan.status.replace("_", " ")} · {done}/{plan.tasks.length} · {percent}%
      </Text>
      <Box marginTop={1} flexDirection="column">
        {start > 0 ? <Text dimColor>↑ {start} earlier task{start === 1 ? "" : "s"}</Text> : null}
        {visible.map(({ task, index }) => (
          <Box key={task.id} flexDirection="row" flexShrink={0}>
            <Text color={taskColor[task.state]} bold={task.state === "in_progress"}>
              {taskGlyph[task.state]} {index + 1}.{" "}
            </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text
                color={taskColor[task.state]}
                dimColor={task.state === "done" || task.state === "skipped"}
                bold={task.state === "in_progress"}
                wrap="wrap"
              >
                {task.title}
                {task.note ? ` — ${task.note}` : ""}
              </Text>
            </Box>
          </Box>
        ))}
        {hiddenBelow > 0 ? <Text dimColor>↓ {hiddenBelow} more task{hiddenBelow === 1 ? "" : "s"}</Text> : null}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor wrap="wrap">
        {plan.status === "draft"
          ? "/implement to approve · Ctrl+H to hide"
          : "Ctrl+H to hide · Ctrl+P for details"}
      </Text>
    </Box>
  );
}
