import type { TaskComplexity, TaskKind } from "./task-plan.js";

export type TaskDepth = "bounded" | "standard" | "deep";
export type TaskCoordination = "direct" | "tracked";
export type TaskVerification =
  | "source-synthesis"
  | "observable-outcome"
  | "behavior-and-regression"
  | "root-cause-regression"
  | "coverage-and-impact";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  shouldPlan: boolean;
  category: TaskKind;
  goal: string;
  depth: TaskDepth;
  coordination: TaskCoordination;
  verification: TaskVerification;
  completionStandard: string;
}

const PENTEST_RE =
  /\b(?:pentest|pen[\s-]?test|penetration|security\s*(?:test|audit|scan|assess)|vapt|csrf|xss|sqli|sql[\s-]?inject|rce|lfi|rfi|ssrf|idor|xxe|deserialization|brute[\s-]?force|enumerat|exploit|vulnerabilit|recon|bug[\s-]?bounty|ctf|capture[\s-]?the[\s-]?flag|red[\s-]?team|offensive|nmap|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit)\b/i;

const BUILD_RE =
  /\b(?:build|scaffold|create|implement|refactor|migrate|bootstrap|set\s*up|setup|integrate|convert|rewrite)\b/i;

const APP_RE =
  /\b(?:app|application|project|website|api|service|cli|dashboard|todo|blog|frontend|backend|library|package|module|feature)\b/i;

const FIX_RE =
  /\b(?:fix|debug|broken|error|failing|crash|bug|regression|not\s+work|doesn'?t\s+work|typeerror|exception|incident|outage)\b/i;

const RESEARCH_RE =
  /\b(?:what\s+is|how\s+(?:do|does|to)|explain|compare|difference|latest|current|who\s+is|when\s+did|why\s+(?:is|does)|review|assess|analy[sz]e|recommend|summari[sz]e)\b/i;

const NETWORK_RE =
  /\b(?:scan|nmap|ping|subnet|cidr|local\s*network|hosts?|ports?|dns|whois|http|https|url|domain|ip\s*address)\b/i;

const SHELL_RE =
  /\b(?:run|execute|install|upgrade|brew|apt|npm\s+i|docker|kubectl|chmod|chown|kill|restart|service|deploy)\b/i;

const FS_RE =
  /\b(?:read|write|edit|file|directory|folder|path|rename|delete|list\s+files?|open\s+)\b/i;

const DEEP_RE =
  /\b(?:all|every|entire|complete|comprehensive|exhaustive|thorough|in[\s-]?depth|production[\s-]?grade|high[\s-]?assurance|end[\s-]?to[\s-]?end|without\s+(?:missing|skipping)|full\s+(?:audit|review|assessment|migration|implementation))\b/i;

const MULTI_SURFACE_RE =
  /\b(?:multi[\s-]?(?:file|service|phase|module|package|repo)|across\s+(?:files|services|modules|packages|the\s+codebase)|roadmap|all\s+phases|system[\s-]?wide|architecture|migration|overhaul)\b/i;

const BOUNDED_RE =
  /\b(?:only|just|single|one\s+(?:command|file|check|scan|change)|exactly|do\s+not\s+broaden|limited\s+to)\b/i;

export function isNarrowExplicitNmapOperation(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, " ").trim();
  const hasNmap = /\bnmap\b/i.test(text);
  const openPortIntent =
    /\b(?:find|check|scan|identify|show|list|discover)\b[\s\S]{0,32}\bopen\s+ports?\b/i.test(text) ||
    /\b(?:which|what)\s+ports?\s+(?:are\s+)?open\b/i.test(text);
  if (!hasNmap && !openPortIntent) return false;
  const explicitRun =
    openPortIntent ||
    /^(?:sudo\s+)?nmap(?:\s|$)/i.test(text) ||
    /\b(?:run|execute|start|perform)\b[\s\S]{0,40}\bnmap\b/i.test(text) ||
    /\bnmap\b[\s\S]{0,20}\bscan\b/i.test(text) ||
    /\bscan\b[\s\S]{0,40}\bwith\s+nmap\b/i.test(text);
  if (!explicitRun) return false;
  if (
    /\b(?:pentest|pen[\s-]?test|penetration|security\s+(?:audit|assessment|test)|vapt|recon(?:naissance)?|enumerat\w*|attack\s+surface|vulnerabilit\w*|exploit\w*|bug\s+bounty|red\s+team|threat\s+model|web\s+assessment)\b/i.test(text)
  ) {
    return false;
  }
  if (
    /\b(?:and|then|also)\b[\s\S]{0,40}\b(?:whois|dns|dig|http|crawl|fuzz|nikto|nuclei|sqlmap|gobuster|ffuf)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

function wordCount(prompt: string): number {
  return prompt.trim().split(/\s+/).filter(Boolean).length;
}

function isInformational(prompt: string): boolean {
  const text = prompt.trim();
  if (text.endsWith("?")) return true;
  if (/^(?:what|which|why|how|when|who|where|is|are|do|does|did|can|could|should|would|will)\b/i.test(text)) {
    return true;
  }
  return RESEARCH_RE.test(text) && !/\b(?:apply|fix|build|implement|change|run|execute|install|deploy)\b/i.test(text);
}

function classifyCategory(prompt: string): TaskKind {
  if (PENTEST_RE.test(prompt)) {
    if (/\b(?:dns|whois|subdomain)\b/i.test(prompt)) return "dns";
    if (/\b(?:dir|fuzz|gobuster|ffuf|content\s*discover)\b/i.test(prompt)) {
      return "web-enum";
    }
    return "pentest-recon";
  }
  if (/\bwhois\b/i.test(prompt)) return "whois";
  if (/\b(?:dns|dig|nslookup|resolve)\b/i.test(prompt)) return "dns";
  if (NETWORK_RE.test(prompt) && /\b(?:discover|sweep|live\s*hosts?)\b/i.test(prompt)) {
    return "network-discovery";
  }
  if (/\b(?:pkg|package|brew\s+install|apt\s+install|install\s+\w+)\b/i.test(prompt)) {
    return "package";
  }
  if (isInformational(prompt)) return "answer";
  if (BUILD_RE.test(prompt) || FIX_RE.test(prompt) || FS_RE.test(prompt)) {
    return "filesystem";
  }
  if (SHELL_RE.test(prompt)) return "shell";
  return "other";
}

function estimateComplexity(
  prompt: string,
  category: TaskKind,
  words: number,
): TaskComplexity {
  if (isNarrowExplicitNmapOperation(prompt)) return "standard";
  if (DEEP_RE.test(prompt) || MULTI_SURFACE_RE.test(prompt)) return "complex";
  if (PENTEST_RE.test(prompt)) return "complex";
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) return "complex";
  if (FIX_RE.test(prompt)) return words > 40 ? "complex" : "standard";
  if (category === "answer" && words <= 20) return "simple";
  if (words <= 6 && !BUILD_RE.test(prompt)) return "simple";
  if (words <= 28 && !BUILD_RE.test(prompt)) return "standard";
  return words > 40 || BUILD_RE.test(prompt) ? "complex" : "standard";
}

function shouldTrack(
  prompt: string,
  complexity: TaskComplexity,
  category: TaskKind,
): boolean {
  if (complexity === "simple" || category === "answer") return false;
  if (isNarrowExplicitNmapOperation(prompt)) return false;
  if (PENTEST_RE.test(prompt) || MULTI_SURFACE_RE.test(prompt)) return true;
  if (BUILD_RE.test(prompt) && APP_RE.test(prompt)) return true;
  return complexity === "complex" && wordCount(prompt) > 25;
}

function depthFor(prompt: string, complexity: TaskComplexity): TaskDepth {
  if (isNarrowExplicitNmapOperation(prompt)) return "bounded";
  if (DEEP_RE.test(prompt)) return "deep";
  if (BOUNDED_RE.test(prompt) && !MULTI_SURFACE_RE.test(prompt)) return "bounded";
  return complexity === "complex" ? "deep" : "standard";
}

function verificationFor(prompt: string, category: TaskKind): TaskVerification {
  if (FIX_RE.test(prompt)) return "root-cause-regression";
  if (PENTEST_RE.test(prompt)) return "coverage-and-impact";
  if (BUILD_RE.test(prompt) || category === "filesystem") return "behavior-and-regression";
  if (category === "answer") return "source-synthesis";
  return "observable-outcome";
}

function completionStandardFor(
  prompt: string,
  category: TaskKind,
  verification: TaskVerification,
): string {
  if (isNarrowExplicitNmapOperation(prompt)) {
    return "The requested bounded scan is evidenced and reported without expanding its scope.";
  }
  if (verification === "root-cause-regression") {
    return "The root cause is supported by evidence, the original failure has a reproducible before/after proof, and relevant neighboring checks pass.";
  }
  if (verification === "coverage-and-impact") {
    return "Material in-scope attack surfaces are reconciled, findings have reproducible impact evidence, and untested or residual surface is explicit.";
  }
  if (verification === "behavior-and-regression") {
    return "Requested behavior and implicit invariants hold, affected integrations and edge paths are covered proportionally, and relevant checks pass.";
  }
  if (category === "answer") {
    return "The answer resolves the user's actual decision with grounded claims, meaningful trade-offs, and explicit uncertainty.";
  }
  return "The requested state is directly observed, side effects are checked, and material unresolved gaps are disclosed.";
}

export function analyzeTask(prompt: string): TaskAnalysis {
  const text = prompt.replace(/\s+/g, " ").trim();
  const words = wordCount(text);
  const category = classifyCategory(text);
  const complexity = estimateComplexity(text, category, words);
  const shouldPlan = shouldTrack(text, complexity, category);
  const verification = verificationFor(text, category);
  return {
    complexity,
    shouldPlan,
    category,
    goal: text.slice(0, 100),
    depth: depthFor(text, complexity),
    coordination: shouldPlan ? "tracked" : "direct",
    verification,
    completionStandard: completionStandardFor(text, category, verification),
  };
}

export function formatTaskAnalysisHint(analysis: TaskAnalysis): string {
  const tracking =
    analysis.coordination === "tracked"
      ? "durable outcome tracking may improve coordination; use it only if it helps"
      : "direct execution is appropriate unless evidence reveals broader required work";
  return [
    `WORK PROFILE (soft signal, not a procedure): domain=${analysis.category}; complexity=${analysis.complexity}; depth=${analysis.depth}; verification=${analysis.verification}.`,
    `Coordination: ${tracking}. Choose methods and tools from the actual system and evidence—do not follow a canned checklist or broaden the user's boundary.`,
    `Completion standard: ${analysis.completionStandard}`,
  ].join("\n");
}
