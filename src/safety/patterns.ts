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
  /curl\s+.*-d\s+@\/(etc\/passwd|etc\/shadow)/i,
  /base64\s+.*\|\s*(curl|wget|nc)/i,
];

export const networkScanTools = ['nmap', 'masscan', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra', 'dirb', 'wfuzz', 'nuclei'];

/** Read-only commands that are safe to auto-execute without user confirmation */
export const readOnlyShellCommands = new Set([
  'whoami', 'hostname', 'uname', 'uptime', 'date', 'id', 'arch', 'sw_vers',
  'pwd', 'true', 'false', 'basename', 'dirname',
  'ls', 'dir', 'head', 'wc', 'file', 'stat',
  'which', 'where', 'whereis', 'type', 'readlink', 'realpath',
  'df', 'lsof', 'md5', 'md5sum', 'sha256sum', 'shasum',
  'ifconfig', 'ipconfig', 'netstat', 'ss', 'route', 'arp',
  'ps', 'pgrep', 'lscpu', 'free', 'vmstat', 'iostat',
  'echo', 'printf',
]);
