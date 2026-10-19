import { getCredential, listCredentials } from "../store/credentials.js";
import type { ToolHandler } from "./tool-types.js";
import { registerSensitiveText } from "../security/known-secrets.js";

export const credentialTools: Record<string, ToolHandler> = {
  async "creds.list"() {
    const entries = await listCredentials();
    return {
      ok: true,
      output: JSON.stringify({ credentials: entries.filter((entry) => entry.kind === "freeform"), machineSudoConfigured: entries.some((entry) => entry.kind === "sudo"), hint: "Use creds.get only for a needed freeform entry, or terminal.send kind:secret credentialId:<id>. Machine sudo is applied directly and cannot be read by the model." }),
    };
  },
  async "creds.get"(args) {
    if (typeof args.id !== "string" || !args.id) return { ok: false, output: "A credential id from creds.list is required." };
    const entry = await getCredential(args.id);
    if (!entry) return { ok: false, output: "Credential not found or reserved for machine sudo. Use creds.list for available freeform entries." };
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 4096;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192) {
      return { ok: false, output: "offset must be a nonnegative integer; limit must be 1–8192 characters." };
    }
    const content = entry.content.slice(offset, offset + limit);
    registerSensitiveText(content);
    return { ok: true, output: JSON.stringify({ id: entry.id, title: entry.title, content, offset, totalCharacters: entry.content.length, ...(offset + limit < entry.content.length ? { nextOffset: offset + limit } : {}) }), sensitive: true };
  },
};
