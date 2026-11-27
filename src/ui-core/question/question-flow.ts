import type {
  QuestionAnswer,
  QuestionRequest,
  UserQuestion,
} from "../../app/ports/question-port.js";

export interface QuestionFlowState {
  readonly index: number;
  readonly cursor: number;
  readonly selected: readonly (readonly number[])[];
  readonly custom: readonly string[];
  readonly editing: boolean;
  readonly draft: string;
}

export type QuestionFlowOutcome =
  | { readonly kind: "continue"; readonly state: QuestionFlowState }
  | { readonly kind: "submit"; readonly answers: readonly QuestionAnswer[] }
  | { readonly kind: "cancel" };

export function questionFlowInitialState(request: QuestionRequest): QuestionFlowState {
  return {
    index: 0,
    cursor: 0,
    selected: request.questions.map(() => []),
    custom: request.questions.map(() => ""),
    editing: false,
    draft: "",
  };
}

export function currentQuestion(request: QuestionRequest, state: QuestionFlowState): UserQuestion {
  return request.questions[state.index]!;
}

export function customRowIndex(question: UserQuestion): number {
  return question.options.length;
}

export function isQuestionAnswered(state: QuestionFlowState, index: number): boolean {
  return (state.selected[index]?.length ?? 0) > 0 || (state.custom[index] ?? "").trim() !== "";
}

export function questionFlowAnswers(
  request: QuestionRequest,
  state: QuestionFlowState,
): QuestionAnswer[] {
  return request.questions.map((question, index) => {
    const custom = (state.custom[index] ?? "").trim();
    return {
      selected: (state.selected[index] ?? []).map((option) => question.options[option]!.label),
      ...(custom ? { custom } : {}),
    };
  });
}

export function isPrintableInput(chord: string, text: string | undefined): text is string {
  if (text === undefined || text.length === 0) return false;
  if (/(?:^|\+)(?:ctrl|alt|meta|super|hyper)(?:\+|$)/.test(chord)) return false;
  return [...text].every((char) => char >= " " && char !== "\x7f");
}

const replaceAt = <T>(list: readonly T[], index: number, value: T): T[] =>
  list.map((entry, position) => (position === index ? value : entry));

const cursorFor = (request: QuestionRequest, state: QuestionFlowState, index: number): number => {
  const first = state.selected[index]?.[0];
  if (first !== undefined) return first;
  return (state.custom[index] ?? "") !== "" ? customRowIndex(request.questions[index]!) : 0;
};

const moveTo = (
  request: QuestionRequest,
  state: QuestionFlowState,
  index: number,
): QuestionFlowOutcome => ({
  kind: "continue",
  state: { ...state, index, cursor: cursorFor(request, state, index), editing: false, draft: "" },
});

const advance = (request: QuestionRequest, state: QuestionFlowState): QuestionFlowOutcome =>
  state.index + 1 >= request.questions.length
    ? { kind: "submit", answers: questionFlowAnswers(request, state) }
    : moveTo(request, state, state.index + 1);

const choose = (
  request: QuestionRequest,
  state: QuestionFlowState,
  option: number,
): QuestionFlowOutcome =>
  advance(request, {
    ...state,
    selected: replaceAt(state.selected, state.index, [option]),
    custom: replaceAt(state.custom, state.index, ""),
  });

const toggle = (state: QuestionFlowState, option: number): QuestionFlowState => {
  const current = state.selected[state.index] ?? [];
  const next = current.includes(option)
    ? current.filter((entry) => entry !== option)
    : [...current, option].sort((a, b) => a - b);
  return { ...state, cursor: option, selected: replaceAt(state.selected, state.index, next) };
};

const startEditing = (question: UserQuestion, state: QuestionFlowState): QuestionFlowOutcome => ({
  kind: "continue",
  state: {
    ...state,
    cursor: customRowIndex(question),
    editing: true,
    draft: state.custom[state.index] ?? "",
  },
});

const pick = (
  request: QuestionRequest,
  state: QuestionFlowState,
  option: number,
): QuestionFlowOutcome =>
  currentQuestion(request, state).multiSelect
    ? { kind: "continue", state: toggle(state, option) }
    : choose(request, state, option);

const editKey = (
  request: QuestionRequest,
  state: QuestionFlowState,
  chord: string,
  text: string | undefined,
): QuestionFlowOutcome => {
  const question = currentQuestion(request, state);
  if (chord === "enter") {
    const value = state.draft.trim();
    const custom = replaceAt(state.custom, state.index, value);
    if (value === "") {
      return { kind: "continue", state: { ...state, custom, editing: false, draft: "" } };
    }
    const selected = question.multiSelect
      ? state.selected
      : replaceAt(state.selected, state.index, []);
    return advance(request, { ...state, custom, selected, editing: false, draft: "" });
  }
  if (chord === "escape") {
    return { kind: "continue", state: { ...state, editing: false, draft: "" } };
  }
  if (chord === "backspace") {
    return { kind: "continue", state: { ...state, draft: [...state.draft].slice(0, -1).join("") } };
  }
  if (chord === "ctrl+u") return { kind: "continue", state: { ...state, draft: "" } };
  if (isPrintableInput(chord, text)) {
    return { kind: "continue", state: { ...state, draft: `${state.draft}${text.replace(/[\r\n\t]+/g, " ")}` } };
  }
  return { kind: "continue", state };
};

export function questionFlowPaste(
  request: QuestionRequest,
  state: QuestionFlowState,
  text: string,
): QuestionFlowState {
  const clean = text.replace(/[\r\n\t]+/g, " ");
  if (!isPrintableInput("", clean)) return state;
  const base = state.editing ? state.draft : (state.custom[state.index] ?? "");
  return {
    ...state,
    cursor: customRowIndex(currentQuestion(request, state)),
    editing: true,
    draft: `${base}${clean}`,
  };
}

export function questionFlowKey(
  request: QuestionRequest,
  state: QuestionFlowState,
  chord: string,
  text?: string,
): QuestionFlowOutcome | undefined {
  if (state.editing) return editKey(request, state, chord, text);
  const question = currentQuestion(request, state);
  const rows = question.options.length + 1;
  const onCustom = state.cursor === customRowIndex(question);

  if (chord === "escape") return { kind: "cancel" };
  if (chord === "up" || chord === "down") {
    const cursor = (state.cursor + (chord === "up" ? -1 : 1) + rows) % rows;
    return { kind: "continue", state: { ...state, cursor } };
  }
  if (/^[1-9]$/.test(chord)) {
    const option = Number(chord) - 1;
    if (option < question.options.length) return pick(request, state, option);
    if (option === customRowIndex(question)) return startEditing(question, state);
    return { kind: "continue", state };
  }
  if (chord === "space") {
    return onCustom ? startEditing(question, state) : pick(request, state, state.cursor);
  }
  if (chord === "enter") {
    if (onCustom) return startEditing(question, state);
    if (!question.multiSelect) return choose(request, state, state.cursor);
    const current = isQuestionAnswered(state, state.index) ? state : toggle(state, state.cursor);
    return advance(request, current);
  }
  if (chord === "left" || chord === "shift+tab") {
    return state.index > 0 ? moveTo(request, state, state.index - 1) : { kind: "continue", state };
  }
  if (chord === "right" || chord === "tab") {
    return isQuestionAnswered(state, state.index) ? advance(request, state) : { kind: "continue", state };
  }
  return undefined;
}
