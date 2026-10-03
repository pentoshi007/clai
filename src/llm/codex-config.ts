import { CHATGPT_SUBSCRIPTION_DISPLAY_NAME } from "./provider-identity.js";
import {
  CODEX_API_BASE_URL,
  codexInstallationId,
  codexPromptCacheKey,
  codexRequestHeaders,
  codexWindowId,
  type CodexCredential,
} from "./codex-auth.js";
import { codexModelMetadata } from "./codex-models.js";
import { nearestAcceptedEffort } from "./reasoning-controls.js";
import { finalizeCodexBody } from "./codex-request.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import { currentSessionAffinity } from "./session-affinity.js";
import type { ReasoningEffort } from "../types.js";
import type { ResponsesBodyExtrasContext, ResponsesDialectConfig } from "./responses-config.js";

export function codexConfigFor(credential: CodexCredential): ResponsesDialectConfig {
  return {
    baseUrl: CODEX_API_BASE_URL,
    providerId: "codex",
    displayName: CHATGPT_SUBSCRIPTION_DISPLAY_NAME,
    artifactDialect: "openai-compatible",
    terminalPolicy: META_STREAM_TERMINAL,
    omitSampling: true,
    maxTokensField: "omit",
    toolStrict: false,
    omitParallelToolCalls: true,
    instructionsField: "leading-instructions",
    systemRole: "developer",
    buildHeaders(auth, accept, context) {
      const cacheKey = codexPromptCacheKey(context);
      const lite = context?.model
        ? codexModelMetadata(credential, context.model)?.responsesLite === true
        : false;
      return {
        "content-type": "application/json",
        accept,
        ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
        ...codexRequestHeaders(
          credential.accountId,
          { ...(lite ? { "x-openai-internal-codex-responses-lite": "true" } : {}) },
          credential.residency,
          cacheKey,
        ),
      };
    },
    reasoningPayload(reasoning, model) {
      const metadata = codexModelMetadata(credential, model ?? "");
      const efforts = metadata?.supportedEfforts ?? [];
      let effort = metadata?.defaultEffort;
      if (reasoning) {
        effort = reasoning.enabled
          ? (efforts.length
              ? nearestAcceptedEffort(
                  reasoning.effort as ReasoningEffort,
                  efforts,
                ) ?? reasoning.effort
              : reasoning.effort)
          : efforts.includes("none") ? "none" : efforts[0];
      }
      const summary = reasoning?.enabled
        ? metadata?.defaultSummary && metadata.defaultSummary !== "none" ? metadata.defaultSummary : "auto"
        : undefined;
      return {
        ...(effort ? { effort } : {}),
        ...(metadata?.supportsSummary !== false && summary && summary !== "none" ? { summary } : {}),
        ...(metadata?.responsesLite ? { context: "all_turns" } : {}),
      };
    },
    bodyExtras(context: ResponsesBodyExtrasContext) {
      const metadata = codexModelMetadata(credential, context.model);
      const cacheKey = codexPromptCacheKey(context);
      const threadId = currentSessionAffinity() ?? cacheKey;
      return {
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: context.parallelToolCalls !== false && !metadata?.responsesLite,
        reasoning: {},
        client_metadata: {
          installation_id: codexInstallationId(),
          session_id: threadId,
          thread_id: threadId,
          window_id: codexWindowId(cacheKey),
        },
        ...(metadata?.supportsVerbosity && metadata.defaultVerbosity
          ? { text: { verbosity: metadata.defaultVerbosity } }
          : {}),
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: cacheKey,
      };
    },
    finalizeBody(body, context) {
      const lite = codexModelMetadata(credential, context.model)?.responsesLite === true;
      return finalizeCodexBody(body, lite);
    },
  };
}
