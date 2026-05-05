export const destructiveCommandPatterns = [
  /\brm\s+-[rfRf]*\s+\//,
  /\brm\s+-[rfRf]*\s+~\b/,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[A-Z]:\\/i,
  /\bformat\s+[A-Z]:/i,
  /\bdd\s+if=.*\s+of=\/dev\//,
  /mkfs\.[a-z0-9]+\s+\/dev\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  /\bshutdown\b.*\b(now|\/s|\/r)\b/i,
];

export const exfiltrationPatterns = [
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*sh/i,
  /tar\s+.*\|\s*(curl|nc|netcat)/i,
  /\bscp\b.*(~\/|\.ssh|\.env)/i,
];

export const networkScanTools = ['nmap', 'masscan', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra'];
