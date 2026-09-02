import { createContext, useContext } from "react";

export interface TerminalDimensions {
  readonly width: number;
  readonly height: number;
}

export const TerminalDimensionsContext = createContext<TerminalDimensions>({
  width: 80,
  height: 24,
});

export function useTerminalDimensionsContext(): TerminalDimensions {
  try {
    return useContext(TerminalDimensionsContext);
  } catch {
    return { width: 100, height: 30 };
  }
}
