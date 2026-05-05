import { detectSystem } from '../os/detect.js';

const askPrompt = 'You are clai in /ask mode. Do NOT execute anything. For every user request, respond with: (1) one-line summary, (2) exact commands for their OS ({{os}}, shell={{shell}}), (3) what each command does, (4) caveats / safer alternatives.';

const agentPrompt = 'You are clai, a terminal AI assistant running on the user\'s {{os}} machine. Working dir: {{cwd}}. Available tools: {{tool_list}}. Plan briefly, then call tools. After tool results, decide next step. For pentesting, ONLY proceed if the user confirmed ownership/authorization. Prefer the OS-native command. If a required binary is missing, propose pkg.install. Stop and summarize when the goal is achieved.';

function render(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((current, [key, value]) => current.replaceAll(`{{${key}}}`, value), template);
}

export function renderAskSystemPrompt(): string {
  const system = detectSystem();
  return render(askPrompt, {
    os: `${system.osName} ${system.release} ${system.arch}`,
    shell: system.shell,
    cwd: system.cwd,
    tool_list: 'none',
  });
}

export function renderAgentSystemPrompt(toolList: string): string {
  const system = detectSystem();
  return render(agentPrompt, {
    os: `${system.osName} ${system.release} ${system.arch}`,
    shell: system.shell,
    cwd: system.cwd,
    tool_list: toolList,
  });
}
