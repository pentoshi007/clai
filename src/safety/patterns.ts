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

/** Read-only commands that are safe to auto-execute without user confirmation */
export const readOnlyShellCommands = new Set([
  // system info
  'whoami', 'hostname', 'uname', 'uptime', 'date', 'id', 'arch', 'sw_vers',
  'lsb_release', 'hostnamectl', 'printenv', 'env', 'locale', 'ulimit',
  'pwd', 'cd', 'test', 'true', 'false', 'basename', 'dirname',
  // file inspection (read-only)
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  'find', 'which', 'where', 'whereis', 'type', 'readlink', 'realpath',
  'tree', 'du', 'df', 'lsof', 'md5', 'md5sum', 'sha256sum', 'shasum',
  // networking info
  'ifconfig', 'ipconfig', 'ip', 'ping', 'traceroute', 'tracert', 'dig',
  'nslookup', 'host', 'whois', 'curl', 'wget', 'netstat', 'ss', 'route',
  'arp', 'iwconfig', 'nmcli',
  // process info
  'ps', 'top', 'htop', 'pgrep', 'lscpu', 'free', 'vmstat', 'iostat',
  // text processing
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'tee', 'xargs', 'jq',
  // git (read-only)
  'git',
  // package query
  'dpkg', 'rpm', 'brew', 'pip', 'npm', 'node', 'python', 'python3', 'ruby',
  // recon / scanning (read-only, pentest auth covers ethics)
  'gobuster', 'dirb', 'ffuf', 'nikto', 'whatweb', 'wpscan',
  'sublist3r', 'amass', 'subfinder', 'httpx', 'nuclei',
]);

