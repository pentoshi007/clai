import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_CREDENTIALS = [
  def("creds.list", "List titles and IDs of private freeform credentials configured with /creds; never returns secret contents. Machine sudo credentials are applied automatically, never disclosed to the model.", emptyObject, { readOnly: true, askMode: true }),
  def("creds.get", "Read one needed freeform credential by ID from creds.list. This discloses its private text to the configured model provider; requires normal secret-access approval. Never echo credentials into chat or logs. Prefer terminal.send kind:secret credentialId:<id> for a password-only entry. Machine sudo cannot be read; shell.exec applies it automatically.", {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      offset: { type: "integer", minimum: 0, description: "Character offset for long entries; follow nextOffset until all needed text is read." },
      limit: { type: "integer", minimum: 1, maximum: 8192, description: "Maximum characters, default 4096. Private output is never written to artifacts." },
    },
    required: ["id"],
    additionalProperties: false,
  }, { readOnly: true }),
];
