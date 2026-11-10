import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OpenAICompatLLM } from '../src/agent/llm.js';

function serve(chunks: object[]): Promise<{ url: string; bodies: any[]; close: () => void }> {
  const bodies: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      bodies.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ url: `http://localhost:${(srv.address() as AddressInfo).port}`, bodies, close: () => srv.close() })));
}
const req = (over = {}) => ({ system: [{ text: 'sys' }], messages: [{ role: 'user' as const, content: 'hi' }], tools: [{ name: 'web_search', description: 'd', input_schema: { type: 'object' } }], allowTools: true, maxTokens: 100, ...over });

test('OpenAI-style: one call split across chunks, two calls by index', async () => {
  const s = await serve([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'web_search', arguments: '{"query":"y"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const r = await new OpenAICompatLLM('k', 'm', s.url).complete(req(), () => {});
  s.close();
  assert.deepEqual(r.content.map((b) => b.type === 'tool_use' && [b.id, b.input]), [['a', { query: 'x' }], ['b', { query: 'y' }]]);
});

test('Gemini-style: parallel calls all arrive with index 0; text streams', async () => {
  const s = await serve([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: 'web_search', arguments: '{"query":"p"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: 'web_search', arguments: '{"query":"q"}' } }] } }] },
  ]);
  let streamed = '';
  const r = await new OpenAICompatLLM('k', 'm', s.url).complete(req(), (d) => (streamed += d));
  s.close();
  assert.equal(streamed, 'Hello');
  const calls = r.content.filter((b) => b.type === 'tool_use') as any[];
  assert.deepEqual(calls.map((c) => c.input.query), ['p', 'q']);
  assert.notEqual(calls[0].id, calls[1].id); // missing ids are synthesised, and unique
});

test('request is converted to OpenAI wire format (tool_calls + role:tool)', async () => {
  const s = await serve([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  await new OpenAICompatLLM('k', 'm', s.url).complete(
    req({
      allowTools: false,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'z' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RES' }] },
      ],
    }),
    () => {},
  );
  s.close();
  const b = s.bodies[0];
  assert.equal(b.tool_choice, 'none');
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.messages[2].tool_calls[0].function.arguments, '{"query":"z"}');
  assert.deepEqual(b.messages[3], { role: 'tool', tool_call_id: 't1', content: 'RES' });
});

test('Gemini 3 thought signatures are captured and echoed back on the next request', async () => {
  const sig = { google: { thought_signature: 'SIG123' } };
  const s1 = await serve([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', extra_content: sig, function: { name: 'web_search', arguments: '{"query":"a"}' } }] } }] }]);
  const r = await new OpenAICompatLLM('k', 'm', s1.url).complete(req(), () => {});
  s1.close();
  const call = r.content.find((b) => b.type === 'tool_use')!;
  const s2 = await serve([{ choices: [{ delta: { content: 'ok' } }] }]);
  await new OpenAICompatLLM('k', 'm', s2.url).complete(req({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'R' }] }] }), () => {});
  s2.close();
  assert.deepEqual(s2.bodies[0].messages[2].tool_calls[0].extra_content, sig);
});

test('falls back to the next model when the first is out of quota', async () => {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const model = JSON.parse(b).model;
      seen.push(model);
      if (model === 'out-of-quota') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"quota"}}');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'from ' + model } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
  const r = await new OpenAICompatLLM('k', 'out-of-quota, backup', url).complete(req(), () => {});
  srv.close();
  assert.deepEqual(seen, ['out-of-quota', 'backup']);
  assert.deepEqual(r.content, [{ type: 'text', text: 'from backup' }]);
});
