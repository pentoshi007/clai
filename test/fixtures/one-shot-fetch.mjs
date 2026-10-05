globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'big-pickle' }] });
  if (!url.endsWith('/chat/completions')) throw new Error(`Unexpected test request: ${url}`);
  const request = JSON.parse(init.body);
  const message = { role: 'assistant', content: 'ONE_SHOT_OK' };
  const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
  if (!request.stream) return Response.json({ choices: [{ message, finish_reason: 'stop' }], usage });
  const chunks = [
    { choices: [{ index: 0, delta: message, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
};
