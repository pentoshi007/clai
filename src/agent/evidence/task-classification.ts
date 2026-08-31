

export type TaskClass =
  | "explore"
  | "scaffold"
  | "install"
  | "implement"
  | "verify"
  | "recon"
  | "exploit"
  | "report"
  | "generic";

export interface TaskWorkSignals {
  sourceWrite?: boolean;
  featureWrite?: boolean;
  installOk?: boolean;
  scaffoldOk?: boolean;
  devServerStart?: boolean;
  localHttpProbeOk?: boolean;
  serverReady?: boolean;
  portListening?: boolean;
  remoteReconOk?: boolean;
  remoteActiveTestOk?: boolean;
}

export function isMetaPlanTool(name: string): boolean {
  return (
    name === "plan.create" ||
    name === "task.move" ||
    name === "job.read" ||
    name === "task.read" ||
    name === "task.update" ||
    name === "agent.handoff"
  );
}

export function isEvidenceWorkTool(name: string): boolean {
  return !isMetaPlanTool(name);
}

export function isPentestPlanKind(kind: string | undefined): boolean {
  return (kind ?? "").toLowerCase() === "pentest";
}

export function classifyTaskTitle(
  title: string,
  opts?: { planKind?: string | undefined },
): TaskClass {
  const t = title.toLowerCase();
  const pentest = isPentestPlanKind(opts?.planKind);

  if (pentest) {
    if (/\b(report|write.?up|finding|summar|document|residual)\b/.test(t)) {
      return "report";
    }
    if (
      /\b(exploit|poc|payload|privesc|lateral|inject|bruteforce|sqlmap|listener|reverse\s+shell|c2)\b/.test(
        t,
      )
    ) {
      return "exploit";
    }
    if (
      /\b(recon|enumerat|fingerprint|osint|whois|dns|nmap|discover|probe|scan|fuzz|content\s+discover|subdomain|port)\b/.test(
        t,
      )
    ) {
      return "recon";
    }
    if (/\b(explore|inspect|list|read|survey|map)\b/.test(t)) {
      return "explore";
    }
    return "generic";
  }

  if (
    /\b(dev\s*server|run\s+dev|start\s+.*server|localhost|shell\.start|leave\s+.*running|probe|verify\s+in\s+browser)\b/.test(
      t,
    ) ||
    (/\b(start|run)\b/.test(t) && /\b(server|dev|app|verify)\b/.test(t))
  ) {
    return "verify";
  }
  if (looksLikeInstallTaskTitle(title)) return "install";
  if (looksLikeScaffoldTaskTitle(title)) return "scaffold";
  if (
    /\b(implement|integrate|feature|rewrite|component|todo|persist|localstorage|styling|styles?|ui|page)\b/.test(
      t,
    ) ||
    (/\b(endpoint|route)\b/.test(t) &&
      /\b(implement|build|add|create|feature|component|ui|page)\b/.test(t))
  ) {
    return "implement";
  }
  if (/\b(recon|enumerat|fingerprint|osint|whois|dns|nmap|discover)\b/.test(t)) {
    return "recon";
  }
  if (
    /\b(exploit|poc|payload|privesc|lateral|inject|bruteforce|sqlmap)\b/.test(t)
  ) {
    return "exploit";
  }
  if (/\b(report|write.?up|finding|summar|document)\b/.test(t)) {
    return "report";
  }
  if (
    /\b(explore|inspect|list|read|survey|map)\b/.test(t) ||
    /\bcheck\b.+\b(exists?|empty|directory|folder|path)\b/.test(t) ||
    /\b(exists?|empty)\b.+\b(directory|folder|path|project)\b/.test(t) ||
    /\bcheck\b.+\b(node|npm|pnpm|yarn|bun|python|availability|available|installed|present|toolchain|tools?)\b/.test(
      t,
    ) ||
    /\b(availability|available|installed|present)\b.+\b(node|npm|toolchain|tools?)\b/.test(
      t,
    ) ||
    /\bverify\b.+\b(tools?|node|npm|setup|environment|prereq)\b/.test(t)
  ) {
    return "explore";
  }
  return "generic";
}

export function toolFitsTaskClass(
  toolName: string,
  taskTitle: string,
  opts?: {
    planKind?: string | undefined;
    signals?: TaskWorkSignals | undefined;
  },
): boolean {
  if (!isEvidenceWorkTool(toolName)) return false;
  const cls = classifyTaskTitle(taskTitle, { planKind: opts?.planKind });
  const s = opts?.signals;
  switch (cls) {
    case "explore":
      return (
        toolName === "tool.check" ||
        toolName === "sysinfo" ||
        toolName === "fs.list" ||
        toolName === "fs.read" ||
        toolName === "fs.search" ||
        toolName === "net.context" ||
        toolName === "shell.exec"
      );
    case "scaffold":
      return (
        Boolean(s?.scaffoldOk) ||
        toolName === "fs.write" ||
        toolName === "fs.writeMany" ||
        toolName === "shell.exec" ||
        toolName === "shell.start"
      );
    case "install":
      return Boolean(s?.installOk) || toolName === "pkg.install";
    case "implement":
      return (
        Boolean(s?.sourceWrite || s?.featureWrite) ||
        toolName === "fs.write" ||
        toolName === "fs.writeMany" ||
        toolName === "fs.edit" ||
        toolName === "fs.replaceLines" ||
        toolName === "fs.append"
      );
    case "verify":
      return (
        Boolean(
          s?.devServerStart ||
            s?.localHttpProbeOk ||
            s?.serverReady ||
            s?.portListening,
        ) ||
        toolName === "shell.start" ||
        toolName === "shell.tail" ||
        toolName === "http.fetch" ||
        toolName === "web.fetch"
      );
    case "recon":
      return (
        Boolean(s?.remoteReconOk) ||
        /^(dns\.lookup|whois\.lookup|http\.fetch|web\.fetch|net\.scan|pentest\.recon|net\.pingSweep|net\.context|tool\.batch)$/.test(
          toolName,
        )
      );
    case "exploit":
      return Boolean(s?.remoteActiveTestOk) || isEvidenceWorkTool(toolName);
    default:
      return true;
  }
}

export function looksLikeInstallTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(install|dependencies|deps|packages)\b/.test(t) &&
    !/\b(dev\s*server|localhost|probe|run\s+dev)\b/.test(t)
  );
}

export function looksLikeScaffoldTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(scaffold|create-vite|create vite|create-next|init project|bootstrap|cargo\s+new|rails\s+new|poetry\s+new)\b/.test(
      t,
    ) ||
    (/\b(create|init|generate)\b/.test(t) &&
      /\b(project|app|package|crate|module|vite)\b/.test(t) &&
      !/\b(feature|component|endpoint|todo|style|persist)\b/.test(t))
  );
}
