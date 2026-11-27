import type {
  QuestionAnswer,
  QuestionOption,
  QuestionRequest,
  UserQuestion,
} from "../app/ports/question-port.js";

export const USER_ASK_TOOL_NAME = "user.ask";
export const USER_ASK_MAX_QUESTIONS = 3;
export const USER_ASK_MIN_OPTIONS = 2;
export const USER_ASK_MAX_OPTIONS = 4;
export const USER_ASK_HEADER_MAX_CHARS = 16;

export const userAskCallLimit = (planMode: boolean): number => (planMode ? 2 : 1);

export const USER_ASK_SKIPPED =
  "The user dismissed the questions without answering. Do not ask again this turn; proceed with your recommended defaults and state them as assumptions.";

export const USER_ASK_UNAVAILABLE =
  "No interactive user can answer questions in this session. Proceed with your recommended defaults and state them as assumptions.";

export const userAskLimitReached = (limit: number): string =>
  `This turn already used its ${limit === 1 ? "user.ask call" : `${limit} user.ask calls`}. Decide the remaining points yourself and state them as assumptions.`;

const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(CONTROL_CHARS, " ").trim() : "";

const line = (value: unknown): string => text(value).replace(/\s*\n\s*/g, " ");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function parseOptions(value: unknown): QuestionOption[] {
  const options: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const fields = typeof entry === "string" ? { label: entry } : record(entry);
    const label = line(fields?.label);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const description = line(fields?.description);
    options.push({ label, ...(description ? { description } : {}) });
  }
  return options;
}

function parseQuestion(value: unknown, position: number): UserQuestion | string {
  const fields = record(value);
  const question = text(fields?.question);
  if (!fields || !question) return `question ${position} needs question text.`;
  const options = parseOptions(fields.options);
  if (options.length < USER_ASK_MIN_OPTIONS || options.length > USER_ASK_MAX_OPTIONS) {
    return `question ${position} needs ${USER_ASK_MIN_OPTIONS} to ${USER_ASK_MAX_OPTIONS} distinct options; the user can always type a different answer.`;
  }
  const header = line(fields.header).slice(0, USER_ASK_HEADER_MAX_CHARS);
  return {
    question,
    ...(header ? { header } : {}),
    options,
    multiSelect: fields.multiSelect === true,
  };
}

export function parseUserQuestions(args: Record<string, unknown>): QuestionRequest | string {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0) {
    return `provide questions: an array of 1 to ${USER_ASK_MAX_QUESTIONS} questions.`;
  }
  if (raw.length > USER_ASK_MAX_QUESTIONS) {
    return `ask at most ${USER_ASK_MAX_QUESTIONS} questions in one call; decide the rest yourself.`;
  }
  const questions: UserQuestion[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseQuestion(entry, index + 1);
    if (typeof parsed === "string") return parsed;
    questions.push(parsed);
  }
  return { questions };
}

function answerText(answer: QuestionAnswer | undefined): string {
  const parts = [...(answer?.selected ?? [])];
  if (answer?.custom) parts.push(`"${answer.custom}"`);
  return parts.length > 0 ? parts.join("; ") : "(no answer)";
}

export function formatUserAnswers(
  request: QuestionRequest,
  answers: readonly QuestionAnswer[],
): string {
  return [
    "The user answered:",
    ...request.questions.flatMap((question, index) => [
      `${index + 1}. ${question.question}`,
      `   → ${answerText(answers[index])}`,
    ]),
    "Treat these answers as decisions. When planning, record them under USER DECISIONS in the plan detail.",
  ].join("\n");
}
