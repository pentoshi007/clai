import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { queueRows, type QueueViewInput } from "./queue-rows.js";

export function QueuePanel(props: QueueViewInput): ReactNode {
  const rows = queueRows(props);
  if (rows.length === 0) return null;
  return <BlockRows id="queue" lines={rows} />;
}
