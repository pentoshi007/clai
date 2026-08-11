import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { toastRows, type ToastViewInput } from "./toast-rows.js";

export function ToastRow(props: ToastViewInput): ReactNode {
  const rows = toastRows(props);
  if (rows.length === 0) return null;
  return <BlockRows id="toast" lines={rows} />;
}
