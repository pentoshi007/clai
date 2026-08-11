import type { ReactNode } from "react";
import { BlockRows } from "../feed/Feed.js";
import { responderRow, responderVisible, type ResponderViewInput } from "./responder-row.js";

export function ResponderStrip(props: ResponderViewInput): ReactNode {
  if (!responderVisible(props.state)) return null;
  return <BlockRows id="responder" lines={[responderRow(props)]} />;
}
