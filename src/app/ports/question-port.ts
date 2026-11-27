export interface QuestionOption {
  readonly label: string;
  readonly description?: string | undefined;
}

export interface UserQuestion {
  readonly question: string;
  readonly header?: string | undefined;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
}

export interface QuestionAnswer {
  readonly selected: readonly string[];
  readonly custom?: string | undefined;
}

export interface QuestionRequest {
  readonly questions: readonly UserQuestion[];
}

export interface QuestionPort {
  ask(request: QuestionRequest): Promise<readonly QuestionAnswer[] | undefined>;
}
