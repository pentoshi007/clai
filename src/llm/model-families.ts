/**
 * Model-family classification shared by request serialization and route
 * profiles. Pure string classification with no runtime dependencies so both
 * the HTTP layer and the profile layer can consume it without cycles.
 */

export type NvidiaReasoningKind =
  | "kimi-thinking" // Kimi K2.6 — reasoning is on by default; `thinking:false` disables it
  | "deepseek-v4" // DeepSeek V4 — `thinking` plus V4's none/high reasoning effort
  | "thinking" // DeepSeek-R1/V3, older Nemotron — `chat_template_kwargs.thinking`
  | "nemotron-3" // Nemotron-3 — `enable_thinking` + reasoning_budget
  | "glm-thinking" // GLM-5/4.5 — `enable_thinking` + `clear_thinking:false`
  | "enable-thinking" // Gemma 3/4 — `chat_template_kwargs.enable_thinking`
  | "effort-only" // gpt-oss, qwen3, mistral 3+ — top-level `reasoning_effort`
  | "none"; // Llama, MiniMax m2.x, Step, Sarvam — no thinking knob

export function classifyNvidiaModel(model: string): NvidiaReasoningKind {
  const m = model.toLowerCase();
  if (/kimi-k2(?:\.6|-thinking|-instruct)?/.test(m)) return "kimi-thinking";
  if (/deepseek-v4/.test(m)) return "deepseek-v4";
  // Match newer Nemotron-3 (uses enable_thinking + reasoning_budget) before
  // the legacy Nemotron pattern below — the older `nemotron` bucket would
  // otherwise swallow these too.
  if (/nemotron-3/.test(m)) return "nemotron-3";
  if (/glm-?[345]/.test(m)) return "glm-thinking";
  if (/gemma-?[34]/.test(m)) return "enable-thinking";
  if (/deepseek-(?:v3|r1)|nemotron/.test(m)) return "thinking";
  if (/gpt-oss|qwen3|mistral-(?:medium|small|large)-(?:[3-9]|\d{2,})/.test(m))
    return "effort-only";
  return "none";
}

export type BynaraReasoningKind =
  | "kimi"
  | "deepseek"
  | "agnes"
  | "stepfun"
  | "none";

export function classifyBynaraModel(model: string): BynaraReasoningKind {
  const m = model.toLowerCase();
  if (/kimi/.test(m)) return "kimi";
  if (/deepseek/.test(m)) return "deepseek";
  if (/agnes/.test(m)) return "agnes";
  if (/stepfun|step-3/.test(m)) return "stepfun";
  return "none";
}
