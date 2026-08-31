export interface RendererSuspendPort {
  suspend(): void;
  resume(): void;
}
