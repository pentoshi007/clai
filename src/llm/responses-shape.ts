export class ChatShapedResponsesPayload extends Error {
  constructor() {
    super("endpoint returned a chat-completions shaped payload on /responses");
    this.name = "ChatShapedResponsesPayload";
  }
}

export function assertResponsesShapedData(data: unknown): void {
  const record = data as { choices?: unknown; output?: unknown } | null;
  if (record && record.choices !== undefined && record.output === undefined) {
    throw new ChatShapedResponsesPayload();
  }
}

export function isChatShapedResponsesPayload(error: unknown): boolean {
  return error instanceof ChatShapedResponsesPayload;
}
