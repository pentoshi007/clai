import chalk from 'chalk';
import { commandAvailable, detectPackageManager } from '../os/pkgmgr.js';
import { detectSystem } from '../os/detect.js';
import { getConfig, getConfigPath } from '../store/config.js';
import { getHistoryPath } from '../store/history.js';
import { getFallbackKeysPath, probeKeychain } from '../store/keys.js';
import { loadScope, isScopeActive, getScopePath } from '../store/scope.js';
import { canUseTui } from '../ui-core/bootstrap/can-use-tui.js';
import {
  findBunExecutable,
  isBunRuntime,
  openTuiRuntimeHint,
} from '../os/bun-runtime.js';
import {
  currentPlatformProbe,
  defaultUiForPlatform,
  describeUiDefault,
  explainUiChoice,
} from '../ui-core/bootstrap/ui-selection.js';
import { printProviderKeys } from './providers.js';
import { resolveToolDialect } from '../llm/capabilities.js';

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
  const probe = currentPlatformProbe();
  const selection = explainUiChoice({}, process.env, probe);
  console.log(`UI default: ${describeUiDefault()}`);
  console.log(
    `UI resolved now: ${chalk.bold(selection.choice)} ${chalk.dim(`(${selection.source}: ${selection.reason})`)}`,
  );
  console.log(
    `UI platform default: ${defaultUiForPlatform(probe)} ${chalk.dim(
      `(${probe.platform}, ${probe.columns ?? 0}x${probe.rows ?? 0}, stdout ${
        probe.stdoutIsTTY ? 'tty' : 'not a tty'
      }, stdin ${probe.stdinIsTTY ? 'tty' : 'not a tty'})`,
    )}`,
  );
  console.log(
    `UI host: ${tuiGate.ok ? chalk.green('ok for full-screen TUI') : chalk.yellow(`unavailable — ${tuiGate.reason}`)}`,
  );
  const bunPath = findBunExecutable();
  console.log(
    `OpenTUI runtime: ${
      isBunRuntime()
        ? chalk.green('Bun (native FFI ok)')
        : bunPath
          ? chalk.yellow(`Node — will re-exec ${bunPath} for TUI`)
          : chalk.red('Bun missing — OpenTUI cannot start')
    }`,
  );
  if (!isBunRuntime() && !bunPath) {
    console.log(chalk.dim(openTuiRuntimeHint().split('\n').slice(1).join('\n')));
  }
  console.log(
    chalk.dim('  OpenTUI: clai (Bun/native runtime)  ·  classic Ink UI: clai --classic'),
  );
  let nodePtyOk = false;
  try {
    await import('node-pty');
    nodePtyOk = true;
  } catch {
  }
  console.log(
    `node-pty: ${
      nodePtyOk
        ? chalk.green('available (interactive terminals)')
        : chalk.yellow('not loaded') +
          chalk.dim(' — interactive terminals use basic pipes (still works, fewer features)')
    }`,
  );
  if (!nodePtyOk) {
    console.log(
      chalk.dim(
        '         To enable: npm i -g @pentoshi/clai --allow-scripts=@pentoshi/clai,node-pty',
      ),
    );
  }
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
  const toolDialect = resolveToolDialect(
    config.defaultProvider,
    config.defaultModel,
    config.toolCalling,
  );
  console.log(
    `Tool calling: ${config.toolCalling ?? 'auto'} → dialect ${toolDialect} for ${config.defaultProvider}/${config.defaultModel}`,
  );
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
