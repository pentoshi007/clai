import chalk from 'chalk';
import { commandAvailable, detectPackageManager } from '../os/pkgmgr.js';
import { detectSystem } from '../os/detect.js';
import { getConfigPath } from '../store/config.js';
import { getHistoryPath } from '../store/history.js';
import { getFallbackKeysPath, probeKeychain } from '../store/keys.js';
import { printProviderKeys } from './providers.js';

const pentestTools = [
  'nmap', 'nikto', 'sqlmap', 'gobuster', 'ffuf', 'hydra', 'masscan',
  'whois', 'dig', 'nc', 'tshark', 'dirb', 'wfuzz', 'nuclei',
  'whatweb', 'wpscan', 'amass', 'subfinder', 'httpx', 'curl', 'jq',
];

export async function runDoctor(): Promise<void> {
  const system = detectSystem();
  const pkgmgr = await detectPackageManager();
  console.log(chalk.bold('clai doctor'));
  console.log(`OS: ${system.osName} ${system.release} ${system.arch}`);
  console.log(`Shell: ${system.shell}`);
  console.log(`CWD: ${system.cwd}`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`History: ${getHistoryPath()}`);
  const keychain = await probeKeychain();
  if (keychain.available) {
    console.log(`Keychain: ${chalk.green('available')} (OS keystore)`);
  } else {
    const reason =
      keychain.reason === 'module-missing'
        ? 'native module not installed'
        : `runtime error — ${keychain.detail?.split('\n')[0] ?? 'unknown'}`;
    console.log(
      `Keychain: ${chalk.yellow('using encrypted file')} ${chalk.dim(`(${reason})`)}`,
    );
    console.log(`         ${chalk.dim(`→ ${getFallbackKeysPath()}`)}`);
  }
  console.log(`Package manager: ${pkgmgr.id}`);
  console.log('');
  console.log(chalk.bold('Providers'));
  await printProviderKeys();
  console.log('');
  console.log(chalk.bold('Tools'));
  for (const tool of pentestTools) {
    const available = await commandAvailable(tool);
    const fix = available ? '' : ` · install: ${pkgmgr.installCommand(tool)}`;
    console.log(`${available ? chalk.green('✓') : chalk.red('✗')} ${tool}${fix}`);
  }
}
