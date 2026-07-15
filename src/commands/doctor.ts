import chalk from 'chalk';
import { commandAvailable, detectPackageManager } from '../os/pkgmgr.js';
import { detectSystem } from '../os/detect.js';
import { getConfig, getConfigPath } from '../store/config.js';
import { getHistoryPath } from '../store/history.js';
import { getFallbackKeysPath, probeKeychain } from '../store/keys.js';
import { loadScope, isScopeActive, getScopePath } from '../store/scope.js';
import { canUseTui } from '../tui/can-use-tui.js';
import {
  UI_CUTOVER_STAGE,
  describeUiDefault,
  resolveUiChoice,
} from '../tui-v2/bootstrap/ui-selection.js';
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
  console.log('Built by: Aniket Pandey, pentoshi007 on GitHub');
  console.log(`OS: ${system.osName} ${system.release} ${system.arch}`);
  console.log(`Shell: ${system.shell}`);
  console.log(`CWD: ${system.cwd}`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`History: ${getHistoryPath()}`);
  const tuiGate = canUseTui();
  const resolvedUi = resolveUiChoice({});
  console.log(
    `UI default: ${describeUiDefault()} ${chalk.dim(`(cutover=${UI_CUTOVER_STAGE})`)}`,
  );
  console.log(
    `UI resolved now: ${resolvedUi}` +
      (process.env.CLAI_UI ? chalk.dim(` (CLAI_UI=${process.env.CLAI_UI})`) : ''),
  );
  console.log(
    `UI host: ${tuiGate.ok ? chalk.green('ok for full-screen TUI') : chalk.yellow(`unavailable — ${tuiGate.reason}`)}`,
  );
  console.log(
    chalk.dim('  opt-in OpenTUI: clai --ui=v2  ·  rollback: --ui=tui | --ui=legacy | --classic'),
  );
  const keychain = await probeKeychain();
  if (keychain.available) {
    console.log(`Keychain: ${chalk.green('available')} (OS keystore)`);
  } else {
    const reason =
      keychain.reason === 'module-missing'
        ? 'native module not installed'
        : `runtime error — ${keychain.detail?.split('\n')[0] ?? 'unknown'}`;
    console.log(
      `Keychain: ${chalk.yellow('using restricted-permission plaintext file')} ${chalk.dim(`(${reason})`)}`,
    );
    console.log(`         ${chalk.dim(`→ ${getFallbackKeysPath()} (mode 0600, NOT encrypted)`)}`);
  }
  console.log(`Package manager: ${pkgmgr.id}`);
  const config = getConfig();
  const offline =
    process.env.CLAI_OFFLINE === '1' ||
    process.env.CLAI_NO_UPDATE_CHECK === '1' ||
    Boolean(config.offline);
  console.log(
    `Update check: ${offline ? chalk.yellow('disabled (offline)') : chalk.green('enabled')}`,
  );
  console.log(
    `Free-only mode: ${config.freeOnly ? chalk.green('on') : chalk.dim('off')}  ` +
      `Provider fallback: ${config.providerFallback ? chalk.green('on') : chalk.dim('off')}  ` +
      `Private mode: ${config.privateMode ? chalk.green('on') : chalk.dim('off')}  ` +
      `Sandbox reads: ${config.sandboxReads === false ? chalk.yellow('off') : chalk.green('on')}  ` +
      `Parser strict: ${config.parserStrict ? chalk.green('on') : chalk.dim('off')}`,
  );
  console.log(
    `History retention: ${config.historyRetentionLimit ? `${config.historyRetentionLimit} sessions` : chalk.yellow('unlimited')}`,
  );
  const scope = await loadScope();
  if (isScopeActive(scope)) {
    console.log(
      `Engagement scope: ${chalk.green('active')} ${chalk.dim(`(${scope.name ?? 'unnamed'} → ${scope.authorizedTargets.join(', ')})`)}`,
    );
  } else {
    console.log(
      `Engagement scope: ${chalk.dim('none')} ${chalk.dim(`(create at ${getScopePath()})`)}`,
    );
  }
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
