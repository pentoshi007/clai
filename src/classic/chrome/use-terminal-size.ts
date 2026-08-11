import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { DEFAULT_COLUMNS, DEFAULT_ROWS } from "../../ui-core/bootstrap/capabilities.js";

export const RESIZE_DEBOUNCE_MS = 80;

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface SizeSource {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export function readTerminalSize(source: SizeSource | undefined): TerminalSize {
  const columns = source?.columns;
  const rows = source?.rows;
  return {
    columns: columns !== undefined && columns > 0 ? columns : DEFAULT_COLUMNS,
    rows: rows !== undefined && rows > 0 ? rows : DEFAULT_ROWS,
  };
}

export function useTerminalSize(debounceMs = RESIZE_DEBOUNCE_MS): TerminalSize {
  const { stdout } = useStdout();
  const source = stdout as unknown as SizeSource | undefined;
  const [size, setSize] = useState(() => readTerminalSize(source));

  useEffect(() => {
    if (!source) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        setSize(readTerminalSize(source));
      }, debounceMs);
    };
    source.on("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      source.off("resize", onResize);
    };
  }, [source, debounceMs]);

  return size;
}
