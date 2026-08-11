import { useEffect, useState } from "react";
import { composerActionPort } from "../composer/composer-action-port.js";

/**
 * Draft emptiness, published by the composer. Status chrome uses it to gate
 * the draft-only chips (^X / ⇧^X) so the row never offers a chord that would
 * currently do nothing.
 */
export function useHasDraft(): boolean {
  const [hasDraft, setHasDraft] = useState(() => composerActionPort.hasDraft());
  useEffect(() => composerActionPort.subscribeDraft(setHasDraft), []);
  return hasDraft;
}
