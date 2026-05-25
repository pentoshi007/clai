import {
  type TaskComplexity,
  type TaskKind,
  type PlanStep,
  createPlanStep,
} from "./task-plan.js";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  shouldPlan: boolean;
  category: TaskKind;
  goal: string;
  needsNetworkContext: boolean;
  needsToolPreflight: boolean;
  likelyTools: string[];
  stopWhen: string;
  suggestedSteps: PlanStep[];
}

/* ── Pattern groups ──────────────────────────────────────────────────── */

const SIMPLE_PATTERNS: Array<{ pattern: RegExp; kind: TaskKind; tools: string[] }> = [
  // Trivial shell info
  { pattern: /^\s*(whoami|hostname|uname|uptime|date|id|arch|sw_vers|pwd)\s*$/i, kind: "shell", tools: ["shell.exec"] },
  // Read a file
  { pattern: /\b(read|cat|show|display|view|print|open)\b.*\b(file|contents?|config)\b/i, kind: "filesystem", tools: ["fs.read"] },
  // List a directory
  { pattern: /\b(list|ls|dir)\b.*\b(files?|dir|folder|directory)\b/i, kind: "filesystem", tools: ["fs.list"] },
  // Single DNS lookup
  { pattern: /\b(MX|AAAA|A\s+record|TXT\s+record|NS\s+record|nameserver|CNAME|SOA|PTR|SRV|CAA)\b.*\b(for|of)\b/i, kind: "dns", tools: ["dns.lookup"] },
  { pattern: /\b(dns|resolve|lookup)\b.*\b(for|of)\b/i, kind: "dns", tools: ["dns.lookup"] },
  // Single whois
  { pattern: /\b(who\s+registered|whois|registrar|domain\s+info|who\s+owns)\b/i, kind: "whois", tools: ["whois.lookup"] },
  // Simple shell commands
  { pattern: /\b(my\s+ip|public\s+ip|what\s+is\s+my\s+ip)\b/i, kind: "shell", tools: ["shell.exec"] },
  { pattern: /\b(disk\s+space|free\s+space|storage)\b/i, kind: "shell", tools: ["shell.exec"] },
  { pattern: /\b(running\s+processes|process\s+list|ps\s+aux)\b/i, kind: "shell", tools: ["shell.exec"] },
  { pattern: /\b(system\s+info|os\s+info|machine\s+info)\b/i, kind: "answer", tools: ["sysinfo"] },
];

const STANDARD_PATTERNS: Array<{ pattern: RegExp; kind: TaskKind; tools: string[] }> = [
  // Network discovery
  { pattern: /\b(my\s+network|local\s+network|LAN|home\s+network)\b/i, kind: "network-discovery", tools: ["net.context", "net.pingSweep"] },
  { pattern: /\b(ping\s+sweep|active\s+devices|live\s+hosts)\b/i, kind: "network-discovery", tools: ["net.context", "net.pingSweep"] },
  { pattern: /\bscan\b.*\b(network|subnet|devices|hosts)\b/i, kind: "network-discovery", tools: ["net.context", "net.pingSweep"] },
  // Single port scan
  { pattern: /\b(port\s+scan|scan\s+ports?|open\s+ports?|nmap)\b/i, kind: "pentest-recon", tools: ["net.scan"] },
  // File editing
  { pattern: /\b(edit|modify|change|update|replace|patch)\b.*\b(file|config|line|text|content)\b/i, kind: "filesystem", tools: ["fs.read", "fs.edit", "fs.write"] },
  // File search
  { pattern: /\b(search|find|grep|look\s+for)\b.*\b(in\s+files?|across|directory|codebase|project)\b/i, kind: "filesystem", tools: ["fs.search"] },
  // Package install
  { pattern: /\b(install|setup|configure)\b.*\b(tool|package|program|software|command)\b/i, kind: "package", tools: ["pkg.install"] },
  // Directory scan (web)
  { pattern: /\b(directory|dir)\s+(scan|brute|fuzz|enum)/i, kind: "web-enum", tools: ["shell.exec"] },
  // File deletion
  { pattern: /\b(delete|remove|rm)\b.*\b(file|directory|folder)\b/i, kind: "filesystem", tools: ["fs.delete"] },
];

const COMPLEX_PATTERNS: Array<{ pattern: RegExp; kind: TaskKind; tools: string[] }> = [
  { pattern: /\b(full\s+recon|reconnaissance|enumerate\s+all|pentest|penetration\s+test)\b/i, kind: "pentest-recon", tools: ["pentest.recon", "net.scan", "shell.exec"] },
  { pattern: /\b(vuln|vulnerability)\s*(scan|assessment|check)\b/i, kind: "pentest-recon", tools: ["net.scan", "shell.exec"] },
  { pattern: /\b(exploit|payload|reverse\s+shell|privilege\s+escalation)\b/i, kind: "pentest-recon", tools: ["shell.exec"] },
  { pattern: /\b(web\s+app\s+scan|nikto|burp|sql\s*injection|xss)\b/i, kind: "web-enum", tools: ["shell.exec", "http.fetch"] },
  { pattern: /\b(subdomain)\s*(enum|find|discover|scan)\b/i, kind: "web-enum", tools: ["shell.exec"] },
];

function matchPatterns(
  prompt: string,
  patterns: Array<{ pattern: RegExp; kind: TaskKind; tools: string[] }>,
): { kind: TaskKind; tools: string[] } | undefined {
  for (const entry of patterns) {
    if (entry.pattern.test(prompt)) {
      return { kind: entry.kind, tools: entry.tools };
    }
  }
  return undefined;
}

function buildSteps(kind: TaskKind, prompt: string): PlanStep[] {
  switch (kind) {
    case "network-discovery":
      return [
        createPlanStep("Detect local network interfaces", "network-discovery", { toolHint: "net.context", required: true }),
        createPlanStep("Sweep for active devices", "network-discovery", { toolHint: "net.pingSweep", required: true }),
        createPlanStep("Summarize discovered hosts", "answer", { required: true }),
      ];
    case "pentest-recon":
      if (/full\s+recon|reconnaissance|enumerate\s+all/i.test(prompt)) {
        return [
          createPlanStep("Whois lookup", "whois", { toolHint: "whois.lookup" }),
          createPlanStep("DNS enumeration", "dns", { toolHint: "dns.lookup" }),
          createPlanStep("Port scan", "pentest-recon", { toolHint: "net.scan" }),
          createPlanStep("Service version detection", "pentest-recon", { toolHint: "net.scan" }),
          createPlanStep("Summarize findings", "answer", { required: true }),
        ];
      }
      return [
        createPlanStep("Port scan", "pentest-recon", { toolHint: "net.scan" }),
        createPlanStep("Report findings", "answer", { required: true }),
      ];
    case "filesystem":
      if (/edit|modify|change|update|replace/i.test(prompt)) {
        return [
          createPlanStep("Read current file contents", "filesystem", { toolHint: "fs.read", required: true }),
          createPlanStep("Apply edit", "filesystem", { toolHint: "fs.edit", required: true }),
          createPlanStep("Verify changes", "filesystem", { toolHint: "fs.read" }),
        ];
      }
      if (/delete|remove/i.test(prompt)) {
        return [
          createPlanStep("Confirm target exists", "filesystem", { toolHint: "fs.list", required: true }),
          createPlanStep("Delete target", "filesystem", { toolHint: "fs.delete", required: true }),
        ];
      }
      return [];
    case "web-enum":
      return [
        createPlanStep("Locate wordlist", "shell", { toolHint: "shell.exec" }),
        createPlanStep("Run enumeration scan", "web-enum", { toolHint: "shell.exec", required: true }),
        createPlanStep("Report discovered paths", "answer", { required: true }),
      ];
    default:
      return [];
  }
}

export function analyzeTask(prompt: string): TaskAnalysis {
  // Try complex first (most specific), then standard, then simple
  const complex = matchPatterns(prompt, COMPLEX_PATTERNS);
  if (complex) {
    return {
      complexity: "complex",
      shouldPlan: true,
      category: complex.kind,
      goal: prompt.slice(0, 100),
      needsNetworkContext: complex.kind === "network-discovery",
      needsToolPreflight: true,
      likelyTools: complex.tools,
      stopWhen: "All enumeration steps complete and findings summarized",
      suggestedSteps: buildSteps(complex.kind, prompt),
    };
  }

  const standard = matchPatterns(prompt, STANDARD_PATTERNS);
  if (standard) {
    return {
      complexity: "standard",
      shouldPlan: true,
      category: standard.kind,
      goal: prompt.slice(0, 100),
      needsNetworkContext: standard.kind === "network-discovery",
      needsToolPreflight: standard.tools.some((t) => t !== "shell.exec" && t !== "fs.read" && t !== "fs.list"),
      likelyTools: standard.tools,
      stopWhen: "Task complete and results reported",
      suggestedSteps: buildSteps(standard.kind, prompt),
    };
  }

  const simple = matchPatterns(prompt, SIMPLE_PATTERNS);
  if (simple) {
    return {
      complexity: "simple",
      shouldPlan: false,
      category: simple.kind,
      goal: prompt.slice(0, 100),
      needsNetworkContext: false,
      needsToolPreflight: false,
      likelyTools: simple.tools,
      stopWhen: "Answer delivered",
      suggestedSteps: [],
    };
  }

  // Fallback: unknown → treat as standard, let model decide
  return {
    complexity: "standard",
    shouldPlan: false,
    category: "other",
    goal: prompt.slice(0, 100),
    needsNetworkContext: false,
    needsToolPreflight: false,
    likelyTools: ["shell.exec"],
    stopWhen: "Task complete",
    suggestedSteps: [],
  };
}
