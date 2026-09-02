export interface ReducerOutput {
  summary: string;
  findings?: unknown;
  warnings?: string[];
}

export type Reducer = (
  raw: string,
  context: { command: string; argv?: string[] | undefined },
) => ReducerOutput;
