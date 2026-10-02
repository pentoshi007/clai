import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  CHATGPT_SUBSCRIPTION_DISPLAY_NAME,
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { ProviderError } from "./http.js";
import { withCodexCredential } from "./codex-credential.js";
import { listCodexModels } from "./codex-models.js";
import { codexConfigFor } from "./codex-config.js";
import {
  CODEX_API_BASE_URL,
  CODEX_CLIENT_VERSION,
  accountIdFromIdToken,
  codexRequestHeaders,
  decodeCodexKey,
  encodeCodexKey,
} from "./codex-auth.js";
import { responsesStream } from "./responses-dialect.js";

export { resetCodexModelCache, codexFallbackModels } from "./codex-models.js";

export const codexProvider: LlmProvider = {
  id: "codex",
  displayName: CHATGPT_SUBSCRIPTION_DISPLAY_NAME,
  reasoningStyle: "openai",
  defaultModel: defaultModels.codex,
  envVar: "CODEX_API_KEY",
  validateKey: (key: string) =>
    decodeCodexKey(key) !== undefined || accountIdFromIdToken(key) !== undefined,
  listModels: listCodexModels,
  async ping(auth: ProviderAuth): Promise<void> {
    await withCodexCredential(auth, async (credential) => {
      const response = await fetch(
        `${CODEX_API_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`,
        {
          headers: {
            authorization: `Bearer ${credential.accessToken}`,
            ...codexRequestHeaders(credential.accountId, {}, credential.residency),
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        throw new ProviderError(
          `${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} authentication failed (HTTP ${response.status}). Run \`clai auth chatgpt\` to sign in.`,
          response.status,
        );
      }
    });
  },
  complete: (request, auth) => runCodexRequest(request, auth, () => {}),
  stream: runCodexRequest,
};

async function resolveCodexModel(
  auth: ProviderAuth,
  requestedModel?: string,
): Promise<string> {
  let available: string[] = [];
  try {
    available = await codexProvider.listModels!(auth);
  } catch {
    return requestedModel ?? defaultModels.codex;
  }
  if (requestedModel) return requestedModel;
  if (available.includes(defaultModels.codex)) {
    return defaultModels.codex;
  }
  return available[0] ?? defaultModels.codex;
}

async function runCodexRequest(
  request: CompletionRequest,
  auth: ProviderAuth,
  onToken: (token: string) => void,
): Promise<CompletionResult> {
  return withCodexCredential(auth, async (credential) => {
    const model = await resolveCodexModel(
      { apiKey: encodeCodexKey(credential) },
      request.model,
    );
    return responsesStream(
      codexConfigFor(credential),
      { ...request, provider: "codex", model },
      { apiKey: credential.accessToken },
      onToken,
      model,
    );
  });
}
