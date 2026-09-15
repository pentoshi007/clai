import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { subagentsRow, subagentsVisible, type SubagentsViewInput } from "./subagents-row.js";

export function SubagentsStrip(props: SubagentsViewInput): ReactNode {
  if (!subagentsVisible(props.state)) return null;
  return <BlockRows id="subagents" lines={[subagentsRow(props)]} />;
}
