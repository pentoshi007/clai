/**
 * Renderer-owned terminal suspension (foreground child processes, pager
 * export). `suspend()` hands the primary screen back to the terminal;
 * `resume()` restores full-screen rendering. Implementations must be
 * idempotent and safe to nest via provider code.
 */
export interface RendererSuspendPort {
  suspend(): void;
  resume(): void;
}
