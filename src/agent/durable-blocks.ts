export const DURABLE_BLOCK_PREFIXES = [
  "REQUEST CONTEXT",
  "ACTIVE PLAN",
  "SESSION STATE / WORKING MEMORY",
  "PROJECT INSTRUCTIONS",
  "ACTIVE SKILLS",
  "DURABLE WORK ENVELOPE",
  "ENGAGEMENT SCOPE",
  "TASK ANALYSIS",
  "PROGRESS GOVERNOR",
] as const;

export function isDurableInjectedBlock(message: {
  role: string;
  content: string;
}): boolean {
  return (
    message.role === "system" &&
    DURABLE_BLOCK_PREFIXES.some((prefix) =>
      message.content.startsWith(prefix),
    )
  );
}
