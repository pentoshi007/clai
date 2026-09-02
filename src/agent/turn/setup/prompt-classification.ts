import type { ChatMessage } from "../../../types.js";
import { isNarrowExplicitNmapOperation } from "../../task-analyzer.js";
import { looksLikeContinueOrResumePrompt } from "../../continue-orient.js";
import {
  looksLikeBuildTask,
  looksLikeIdleOrSocialPrompt,
  looksLikeInformationalQuery,
  looksLikePentestTask,
} from "../../tool-call-parser.js";

export interface PromptClassification {
  readonly buildLikeTurn: boolean;
  readonly pentestLikeTurn: boolean;
  readonly narrowNmapOperation: boolean;
  readonly informationalQuery: boolean;
  readonly idleOrSocialPrompt: boolean;
  readonly suppressDiagnostics: boolean;
}

export const classifyTurnPrompt = (
  prompt: string,
  history: ChatMessage[] | undefined,
): PromptClassification => {
  const informationalQuery = looksLikeInformationalQuery(prompt);
  const idleOrSocialPrompt = looksLikeIdleOrSocialPrompt(prompt);
  return {
    buildLikeTurn: looksLikeBuildTask(prompt, history),
    pentestLikeTurn: looksLikePentestTask(prompt, history),
    narrowNmapOperation: isNarrowExplicitNmapOperation(prompt),
    informationalQuery,
    idleOrSocialPrompt,
    suppressDiagnostics:
      informationalQuery ||
      idleOrSocialPrompt ||
      looksLikeContinueOrResumePrompt(prompt),
  };
};
