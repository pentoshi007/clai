import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_CREDENTIALS = [
  def("creds.list", "List IDs and titles of /creds entries; contents are never returned.", emptyObject, { readOnly: true, askMode: true }),
  def("creds.get", "Read a /creds entry by ID after secret approval; this discloses it to the model provider, so never echo it. Password-only entries: prefer terminal.send credentialId. Machine sudo is unreadable.", {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      offset: { type: "integer", minimum: 0, description: "Follow nextOffset." },
      limit: { type: "integer", minimum: 1, maximum: 8192, description: "Default 4096." },
    },
    required: ["id"],
    additionalProperties: false,
  }, { readOnly: true }),
];
