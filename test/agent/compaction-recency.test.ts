import { describe, expect, it } from 'vitest';
import {
  compactMessagesWithSummary,
  type CompactionSummaryStage,
} from '../../src/agent/context-manager.js';
import {
  buildCompactionUserPrompt,
  compactionSinglePassInputBudget,
} from '../../src/agent/compaction-summary.js';
import type { ChatMessage } from '../../src/types.js';

const LAST_TOOL = 'web.fetch https://example.test/clai-post';
const LAST_ANSWER = 'Here are all 10 posts; the clai one is a launch deep-dive.';

const USABLE_SUMMARY = [
  '## User goals',
  '- recon the site',
  '## Work completed',
  '- ran the lookups and read the post',
  '## Current state',
  '- research complete',
  '## Remaining work',
  '- none',
].join('\n');

function history(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYS PROMPT' },
    { role: 'user', content: 'find info about example.test' },
  ];
  for (const tool of ['dns.lookup', 'whois.lookup', 'http.fetch', 'shell.exec']) {
    messages.push({
      role: 'assistant',
      content: `running ${tool}`,
      toolCalls: [{ id: tool, name: tool, args: {} }],
    });
    messages.push({ role: 'tool', content: `${tool} ok`, toolCallId: tool });
  }
  messages.push({ role: 'user', content: 'now find the post about you' });
  messages.push({
    role: 'assistant',
    content: 'fetching the post',
    toolCalls: [{ id: LAST_TOOL, name: 'web.fetch', args: {} }],
  });
  messages.push({
    role: 'tool',
    content: `${LAST_TOOL} -> 200 OK`,
    toolCallId: LAST_TOOL,
  });
  messages.push({ role: 'assistant', content: LAST_ANSWER });
  return messages;
}

const VISUAL = [
  'USER INTENT/PROMPT:\nfind info about example.test',
  'TOOL/COMMAND: dns.lookup\nSTATUS: ok',
  'USER INTENT/PROMPT:\nnow find the post about you',
  `TOOL/COMMAND: web.fetch\nINPUT: ${LAST_TOOL}\nSTATUS: ok`,
  `ASSISTANT RESPONSE:\n${LAST_ANSWER}`,
].join('\n\n---\n\n');

interface Capture {
  calls: number;
  seen: string[];
  sources: (readonly ChatMessage[] | undefined)[];
}

async function compact(
  messages: ChatMessage[],
  sessionTranscript: string | undefined,
  contextWindow: number,
  reply: (call: number) => string = () => USABLE_SUMMARY,
): Promise<Capture> {
  const capture: Capture = { calls: 0, seen: [], sources: [] };
  await compactMessagesWithSummary(
    messages,
    async (prompt: string, stage?: CompactionSummaryStage) => {
      capture.calls += 1;
      capture.sources.push(stage?.sourceMessages);
      const fromMessages = (stage?.sourceMessages ?? [])
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');
      capture.seen.push(`${fromMessages}\n${prompt}`);
      return reply(capture.calls);
    },
    {
      budgetTokens: 0,
      keepRecent: 2,
      singlePassInputBudgetTokens:
        compactionSinglePassInputBudget(contextWindow),
    },
    sessionTranscript,
  );
  return capture;
}

describe('compaction sees the end of the session', () => {
  it('shows the final tool call and answer on the direct single-pass path', async () => {
    const capture = await compact(history(), undefined, 200_000);
    const all = capture.seen.join('\n');

    expect(all).toContain(LAST_TOOL);
    expect(all).toContain(LAST_ANSWER);
  });

  it('shows the final tool call and answer on the visual-transcript path', async () => {
    const capture = await compact(history(), VISUAL, 200_000);
    const all = capture.seen.join('\n');

    expect(all).toContain(LAST_TOOL);
    expect(all).toContain(LAST_ANSWER);
  });

  it('shows the final tool call and answer on the serialized path', async () => {
    const capture = await compact(history(), undefined, 20_000);
    const all = capture.seen.join('\n');

    expect(all).toContain(LAST_TOOL);
    expect(all).toContain(LAST_ANSWER);
  });

  it('passes the live message prefix by identity so prompt caching still hits', async () => {
    const messages = history();
    const capture = await compact(messages, undefined, 200_000);
    const source = capture.sources.find((entry) => entry?.length);

    expect(source).toBeDefined();
    expect(source!.length).toBe(messages.length);
    expect(source!.every((message, index) => message === messages[index])).toBe(
      true,
    );
  });

  it('makes exactly one summarizer call when the summary is usable', async () => {
    const capture = await compact(history(), undefined, 200_000);
    expect(capture.calls).toBe(1);
  });

  it('fails without a second summarizer call when the summary is unusable', async () => {
    for (const bad of [
      '',
      'TOOL: Tool result\n[tools: fs.read]\nbytes = 12 lines = 3',
      '## Work completed\n- we did the',
    ]) {
      let calls = 0;
      await expect(
        compactMessagesWithSummary(
          history(),
          async () => {
            calls += 1;
            return bad;
          },
          {
            budgetTokens: 0,
            keepRecent: 2,
            singlePassInputBudgetTokens:
              compactionSinglePassInputBudget(200_000),
          },
          undefined,
        ),
      ).rejects.toThrow(/compaction failed/);
      expect(calls).toBe(1);
    }
  });

  it('instructs the summarizer never to report completed work as remaining', () => {
    const prompt = buildCompactionUserPrompt({ messageTranscript: 'x' });

    expect(prompt).toContain('RECENCY');
    expect(prompt).toMatch(/NEVER list completed work under Remaining work/);
    expect(prompt).toMatch(/reverted, replaced, or abandoned/);
  });
});
