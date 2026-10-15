import { currentZenSessionId, zenUserAgent } from "./zen-session.js";

export function zenClientHeaders(apiKey = ""): Record<string, string> {
  const session = currentZenSessionId();
  return {
    "user-agent": zenUserAgent(),
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    authorization: `Bearer ${apiKey || "public"}`,
  };
}

export function kiloClientHeaders(apiKey = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "opencode-kilo-provider",
    "x-kilocode-editorname": "Kilo CLI",
  };
  return apiKey ? { ...headers, authorization: `Bearer ${apiKey}` } : headers;
}
