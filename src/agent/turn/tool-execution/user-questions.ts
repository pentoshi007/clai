import type { QuestionPort } from "../../../app/ports/question-port.js";
import type { ToolCall } from "../../../types.js";
import {
  formatUserAnswers,
  parseUserQuestions,
  USER_ASK_SKIPPED,
  USER_ASK_UNAVAILABLE,
  userAskLimitReached,
} from "../../../tools/user-ask.js";

export interface UserQuestionPorts {
  readonly ask: QuestionPort["ask"] | undefined;
  readonly acquirePrompt: () => Promise<() => void>;
  readonly limit: number;
  readonly used: () => number;
  readonly setUsed: (count: number) => void;
}

export interface UserQuestionResult {
  readonly ok: boolean;
  readonly output: string;
}

export const askUserQuestions = async (
  ports: UserQuestionPorts,
  call: ToolCall,
): Promise<UserQuestionResult> => {
  const request = parseUserQuestions(call.args);
  if (typeof request === "string") return { ok: false, output: `user.ask failed: ${request}` };
  if (!ports.ask) return { ok: false, output: USER_ASK_UNAVAILABLE };
  if (ports.used() >= ports.limit) return { ok: false, output: userAskLimitReached(ports.limit) };
  ports.setUsed(ports.used() + 1);
  const release = await ports.acquirePrompt();
  try {
    const answers = await ports.ask(request);
    if (!answers) {
      ports.setUsed(ports.limit);
      return { ok: true, output: USER_ASK_SKIPPED };
    }
    return { ok: true, output: formatUserAnswers(request, answers) };
  } finally {
    release();
  }
};
