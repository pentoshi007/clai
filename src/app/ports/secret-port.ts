
import type { ToolCall } from "../../types.js";

export interface SecretRequest {
  readonly title: string;
  readonly prompt: string;
  readonly operation?: ToolCall | undefined;
}

export interface SecretPort {
  request(request: SecretRequest): Promise<string | undefined>;
}
