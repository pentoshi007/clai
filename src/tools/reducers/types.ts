/**
 * A reducer takes raw tool output and returns a compact, finding-aware
 * summary that the model sees instead of the raw blob. The full raw output
 * still lives in the artifact file for the user to inspect.
 */
export interface ReducerOutput {
  summary: string;
  findings?: unknown;
  warnings?: string[];
}

export type Reducer = (
  raw: string,
  context: { command: string; argv?: string[] | undefined },
) => ReducerOutput;
