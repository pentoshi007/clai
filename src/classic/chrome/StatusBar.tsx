import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { statusRows, type StatusViewInput } from "./status-rows.js";

export function StatusBar(props: StatusViewInput): ReactNode {
  return <BlockRows id="status" lines={statusRows(props)} />;
}