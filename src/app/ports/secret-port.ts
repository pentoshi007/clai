/**
 * Masked secret entry (CORE-002, INPUT-009). Secret values are typed
 * separately from generic event payloads and never enter the transcript, logs,
 * history, or clipboard without explicit user action.
 */
export interface SecretRequest {
  readonly title: string;
  readonly prompt: string;
}

export interface SecretPort {
  request(request: SecretRequest): Promise<string | undefined>;
}
