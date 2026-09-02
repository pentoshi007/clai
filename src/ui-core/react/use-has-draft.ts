import { useEffect, useState } from "react";
import { composerActionPort } from "../composer/composer-action-port.js";

export function useHasDraft(): boolean {
  const [hasDraft, setHasDraft] = useState(() => composerActionPort.hasDraft());
  useEffect(() => composerActionPort.subscribeDraft(setHasDraft), []);
  return hasDraft;
}
