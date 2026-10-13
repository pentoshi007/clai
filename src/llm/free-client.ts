import { randomUUID } from "node:crypto";
import { currentSessionAffinity } from "./session-affinity.js";

const OPENCODE_USER_AGENT = "opencode/2.0.8";
const ID_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let idLastTimestamp = 0;
let idCounter = 0;

function createSessionId(descending = true, timestamp = Date.now()): string {
  if (timestamp !== idLastTimestamp) {
    idLastTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return "ses_" + time + Array.from(bytes, (byte) => ID_CHARS[byte % 62]).join("");
}

const gatewayIdentity = { session: createSessionId() };
const zenSessionMap = new Map<string, string>();

function resolveZenSession(): string {
  const affinity = currentSessionAffinity();
  if (!affinity) return gatewayIdentity.session;
  if (affinity.startsWith("ses_")) return affinity;
  let session = zenSessionMap.get(affinity);
  if (!session) {
    session = createSessionId();
    zenSessionMap.set(affinity, session);
  }
  return session;
}

export function zenClientHeaders(apiKey = ""): Record<string, string> {
  return {
    "user-agent": OPENCODE_USER_AGENT,
    "x-opencode-session": resolveZenSession(),
    "x-opencode-request": `msg_${randomUUID().replaceAll("-", "")}`,
    "x-opencode-client": "cli",
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
