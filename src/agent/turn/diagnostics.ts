export type AgentDiagnostic =
  | { readonly type: "assembly"; readonly phase: "turn-setup" | "request"; readonly elapsedMs: number }
  | { readonly type: "model-round"; readonly step: number }
  | { readonly type: "tool-repair"; readonly reason: "bare-arguments" | "sentinel" | "truncated" | "malformed-json" };

export type AgentDiagnosticSink = (diagnostic: AgentDiagnostic) => void;
