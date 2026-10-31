import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { goalRow, goalVisible, type GoalRowInput } from "./goal-row.js";

export function GoalStrip(props: GoalRowInput): ReactNode {
  if (!goalVisible(props.goal)) return null;
  return <BlockRows id="goal" lines={[goalRow(props)]} />;
}
