import { useEffect, useState } from "react";
import type { SessionController } from "../../app/controllers/session-controller.js";

export function useSessionState(session: SessionController) {
  const [state, setState] = useState(() => session.getState());
  useEffect(() => session.subscribe(() => setState(session.getState())), [session]);
  return state;
}
