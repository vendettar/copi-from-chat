import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { Markdown } from '@earendil-works/pi-tui';
import { createCopilotProvider } from '../src/pi-provider.js';

const user = text => ({ role: 'user', content: text, timestamp: 1 });
const tool = { name: 'bash', description: 'Run Git Bash', parameters: {
  type: 'object', properties: { command: { type: 'string' } }, required: ['command']
} };
const base = { systemPrompt: 'Use local tools.', messages: [user('First task.')], tools: [tool] };
const reply = (request, value = { type: 'final', text: 'Done.' }) => {
  const text = JSON.stringify({ requestId: request.requestId, ...value });
  return { completed: true, text, codeBlocks: [text] };
};
const textOf = message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('');
function harness(respond = request => reply(request), providerOptions = {}) {
  const requests = [], events = [];
  const provider = createCopilotProvider({ async ask(prompt, options) {
    const request = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
    requests.push({ request, options, prompt });
    return respond(request, requests.length, events);
  } }, providerOptions);
  return { requests, events, async run(context = base, options = {}) {
    const stream = provider.streamSimple(provider.getModels()[0], normalizeContext(context), options);
    for await (const event of stream) events.push(event);
    return stream.result();
  } };
}

test('final lines render as multiline Markdown without unescaping code, regexes or Windows paths', async () => {
  const lines = [
    '# Result', '', 'First paragraph.', '', 'Second paragraph.', '', '- First item', '- Second item', '',
    '```js', String.raw`const text = "first\nsecond";`, String.raw`const pattern = /\r?\n/g;`, '```', '',
    'Path: `' + String.raw`C:\new\repo\test.js` + '`', 'Literal escape: `' + String.raw`\n` + '`'
  ];
  const h = harness(request => reply(request, { type: 'final', lines }));
  const result = await h.run();
  const expected = lines.join('\n');
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content[0].text, expected);
  assert.equal(h.events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), expected);
  const theme = Object.fromEntries(['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder',
    'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'].map(name => [name, text => text]));
  const rendered = new Markdown(expected, 0, 0, theme).render(100).map(line => line.trimEnd());
  const first = rendered.indexOf('First paragraph.');
  assert.ok(first >= 0);
  assert.equal(rendered[first + 1], '');
  assert.equal(rendered[first + 2], 'Second paragraph.');
  assert.ok(rendered.some(line => line.includes(String.raw`const text = "first\nsecond";`)));
  assert.ok(rendered.some(line => line.includes(String.raw`C:\new\repo\test.js`)));
  assert.ok(rendered.some(line => line.includes(String.raw`Literal escape: \n`)));
  await h.run({ ...base, messages: [...base.messages, result, user('Continue.')] });
  assert.equal(h.requests[1].request.mode, 'continue');
  assert.deepEqual(h.requests[1].request.messages.map(textOf), ['Continue.']);
});

test('double-escaped final text is corrected once into lines before any text is displayed', async () => {
  const lines = ['第一段', '', '第二段', '- 项目一', '- 项目二'];
  const h = harness((request, count) => reply(request, count === 1
    ? { type: 'final', text: String.raw`第一段\n\n第二段\n- 项目一\n- 项目二` }
    : { type: 'final', lines }));
  const result = await h.run();
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content[0].text, lines.join('\n'));
  const correction = h.requests[1].request;
  assert.equal(correction.mode, 'repair');
  assert.match(correction.formatIssue, /literal backslash/);
  assert.equal(correction.messages, undefined);
  assert.equal(correction.replacesRequestId, h.requests[0].request.requestId);
  assert.equal(h.requests[1].options.fresh, false);
  assert.deepEqual(h.events.filter(event => event.type === 'text_delta').map(event => event.delta), [lines.join('\n')]);
  await h.run({ ...base, messages: [...base.messages, result, user('Next.')] });
  assert.equal(h.requests[2].request.previousRequestId, correction.requestId);
});

test('ordinary JSON newline escapes still decode once without a correction', async () => {
  const text = '第一行\n第二行\n\n第三段';
  const h = harness(request => reply(request, { type: 'final', text }));
  const result = await h.run();
  assert.equal(result.content[0].text, text);
  assert.equal(h.requests.length, 1);
});

test('ambiguous legacy escapes are not guessed or displayed when correction fails', async () => {
  const h = harness(request => reply(request, { type: 'final', text: String.raw`Use \n and C:\new\repo.` }));
  const result = await h.run();
  assert.equal(result.stopReason, 'error');
  assert.equal(h.requests.length, 2);
  assert.equal(h.events.some(event => event.type === 'text_delta'), false);
});

test('malformed line arrays and conflicting final fields cannot become visible replies', async () => {
  for (const fields of [
    { lines: [] }, { lines: [' ', ''] }, { lines: [42] }, { lines: 'not an array' },
    { lines: ['first\nsecond'] }, { lines: ['first\rsecond'] }, { lines: ['Valid'], text: 'Conflicting' }
  ]) {
    const h = harness(request => reply(request, { type: 'final', ...fields }));
    assert.equal((await h.run()).stopReason, 'error');
    assert.equal(h.requests.length, 2);
    assert.equal(h.events.some(event => event.type === 'text_delta'), false);
  }
});

test('tool arguments keep literal escapes, real newlines and paths exactly as decoded from JSON', async () => {
  const command = String.raw`printf '%s\n' 'C:\new\repo'` + '\n' + String.raw`printf '%s' '\n'`;
  const h = harness(request => reply(request, { type: 'tool_calls', calls: [{ name: 'bash', arguments: { command } }] }));
  const result = await h.run();
  assert.equal(result.stopReason, 'toolUse');
  assert.equal(result.content[0].arguments.command, command);
  assert.equal(h.requests.length, 1);
});

test('later user turns send only the delta even when accumulated history exceeds the message budget', async () => {
  const h = harness(request => reply(request, { type: 'final', text: 'x'.repeat(25000) }));
  const first = await h.run();
  const second = await h.run({ ...base, messages: [...base.messages, first, user('Continue.')] });
  assert.equal(second.stopReason, 'stop');
  const { request, options, prompt } = h.requests[1];
  assert.equal(request.mode, 'continue');
  assert.equal(request.systemPrompt, undefined);
  assert.equal(request.tools, undefined);
  assert.equal(request.previousRequestId, h.requests[0].request.requestId);
  assert.deepEqual(request.messages.map(textOf), ['Continue.']);
  assert.ok(prompt.length < 4000);
  assert.equal(options.requireContinuation, true);
  assert.equal(options.fresh, false);
});

test('tool results are sent once with IDs linked to the preceding web reply', async () => {
  const h = harness((request, count) => count === 1
    ? reply(request, { type: 'tool_calls', calls: [{ name: 'bash', arguments: { command: 'pwd' } }] })
    : reply(request));
  const first = await h.run();
  const result = { role: 'toolResult', toolCallId: first.content[0].id, toolName: 'bash',
    isError: false, content: [{ type: 'text', text: 'C:/project' }], timestamp: 2 };
  assert.equal((await h.run({ ...base, messages: [...base.messages, first, result] })).stopReason, 'stop');
  const delta = h.requests[1].request;
  assert.equal(delta.messages.length, 1);
  assert.equal(delta.messages[0].role, 'toolResult');
  assert.equal(delta.messages[0].toolCallId, delta.previousRequestId + '_0');
});

test('format correction references the failed reply without resending task history', async () => {
  const h = harness((request, count) => count === 1
    ? { completed: true, text: 'Please clarify your request.' } : reply(request));
  const first = await h.run();
  assert.equal(first.stopReason, 'stop');
  const correction = h.requests[1].request;
  assert.equal(correction.mode, 'repair');
  assert.equal(correction.replacesRequestId, h.requests[0].request.requestId);
  assert.notEqual(correction.requestId, correction.replacesRequestId);
  assert.equal(correction.messages, undefined);
  assert.deepEqual(correction.tools, [tool]);
  await h.run({ ...base, messages: [...base.messages, first, user('Next.')] });
  assert.equal(h.requests[2].request.previousRequestId, correction.requestId);
  assert.equal(h.requests[2].request.mode, 'continue');
});

test('session, catalog and history changes stop without reconstructing web context', async () => {
  for (const change of ['session', 'catalog', 'history']) {
    const h = harness();
    const first = await h.run(base, { sessionId: 'one' });
    const next = { ...base, messages: [...base.messages, first, user('Next.')] };
    if (change === 'catalog') next.systemPrompt = 'Different instructions.';
    if (change === 'history') next.messages[0] = user('Different branch.');
    const result = await h.run(next, { sessionId: change === 'session' ? 'two' : 'one' });
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Use \/new/);
    assert.equal(h.requests.length, 1);
  }
});

test('duplicate and empty continuations stay blocked without losing the last valid history anchor', async () => {
  const h = harness();
  const first = await h.run();
  assert.equal((await h.run()).stopReason, 'error');
  assert.equal((await h.run()).stopReason, 'error');
  assert.equal((await h.run({ ...base, messages: [...base.messages, first] })).stopReason, 'error');
  assert.equal(h.requests.length, 1);
  await h.run({ ...base, messages: [...base.messages, first, user('Next.')] });
  assert.equal(h.requests[1].request.mode, 'continue');
});

test('a lost web conversation proven before Send recovers once in a fresh web conversation', async () => {
  const h = harness((request, count) => {
    if (count === 2) {
      throw Object.assign(new Error('No active conversation; nothing entered.'), {
        code: 'COPILOT_CONTEXT_LOST', beforeSend: true, retryableInFreshChat: true
      });
    }
    return reply(request);
  });
  const first = await h.run();
  const context = { ...base, messages: [...base.messages, first, user('Continue.')] };
  const second = await h.run(context);
  assert.equal(second.stopReason, 'stop');
  assert.deepEqual(h.requests.map(({ request, options }) => [request.mode, options.fresh]), [
    ['bootstrap', true],
    ['continue', false],
    ['bootstrap', true]
  ]);
  assert.equal(h.requests[2].request.resumed, true);
  // Subsequent turns continue sending only deltas on the recovered fresh chat.
  const third = await h.run({ ...base, messages: [...context.messages, second, user('Next.')] });
  assert.equal(third.stopReason, 'stop');
  assert.equal(h.requests[3].request.mode, 'continue');
  assert.deepEqual(h.requests[3].request.messages.map(textOf), ['Next.']);
});

test('a lost web conversation without beforeSend proof stops without replaying old history', async () => {
  const h = harness((request, count) => {
    if (count === 2) throw Object.assign(new Error('No active conversation; state uncertain.'), { code: 'COPILOT_CONTEXT_LOST' });
    return reply(request);
  });
  const first = await h.run();
  const context = { ...base, messages: [...base.messages, first, user('Continue.')] };
  const second = await h.run(context);
  assert.equal(second.stopReason, 'error');
  assert.match(second.errorMessage, /Use \/new/);
  assert.deepEqual(h.requests.map(({ request }) => request.mode), ['bootstrap', 'continue']);
  const retry = await h.run({ ...base, messages: [...context.messages, second, user('Next.')] });
  assert.equal(retry.stopReason, 'error');
  assert.match(retry.errorMessage, /Use \/new/);
  assert.equal(h.requests.length, 2);
});

test('an uncertain send is never automatically replayed', async () => {
  const h = harness((request, count) => {
    if (count === 2) throw new Error('Timed out after clicking Send.');
    return reply(request);
  });
  const first = await h.run();
  const result = await h.run({ ...base, messages: [...base.messages, first, user('Continue.')] });
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /Use \/new/);
  await h.run();
  assert.equal(h.requests.length, 2);
});

test('a resumed session with >12 messages sends proactive compacted bootstrap while reusing live tabs when available', async () => {
  // Build a 14-message local history.
  const messages = [];
  for (let i = 0; i < 7; i++) {
    messages.push(user(`User turn ${i}: keep this instruction intact.`));
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `Assistant decision ${i}.` }], timestamp: i + 1 });
  }
  messages.push(user('Final resumed instruction.'));

  // Case 1: Fresh tab bootstrap compacts proactively (>12 messages).
  const h = harness();
  const resumed = await h.run({ ...base, messages }, { sessionId: 'sess-compact' });
  assert.equal(resumed.stopReason, 'stop');
  assert.equal(h.requests[0].request.mode, 'bootstrap');
  assert.equal(h.requests[0].request.resumed, true);
  assert.equal(h.requests[0].request.compacted, true);
  assert.ok(h.requests[0].request.messages.length < messages.length);
  assert.equal(textOf(h.requests[0].request.messages[0]), 'User turn 0: keep this instruction intact.');
  assert.equal(textOf(h.requests[0].request.messages.at(-1)), 'Final resumed instruction.');
  // Next turn still sends only the delta because lastTurn anchored to the unmodified full history.
  const next = await h.run({ ...base, messages: [...messages, resumed, user('Delta turn.')] }, { sessionId: 'sess-compact' });
  assert.equal(next.stopReason, 'stop');
  assert.equal(h.requests[1].request.mode, 'continue');
  assert.deepEqual(h.requests[1].request.messages.map(textOf), ['Delta turn.']);

  // Case 2: Live Browser Host tab continuation skips bootstrap and continues directly.
  let storedTurn = null;
  const liveRequests = [];
  const sharedBrowser = {
    async getContinuationState(sessionId) {
      return storedTurn && storedTurn.sessionId === sessionId
        ? { hasContinuation: true, lastTurn: storedTurn }
        : { hasContinuation: false, lastTurn: null };
    },
    async saveTurnState(_sessionId, turn) { storedTurn = turn; },
    async ask(prompt, options) {
      const request = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      liveRequests.push({ request, options });
      return reply(request);
    }
  };
  const provider1 = createCopilotProvider(sharedBrowser);
  const s1 = provider1.streamSimple(provider1.getModels()[0], normalizeContext(base), { sessionId: 'live-sess' });
  for await (const _ of s1) {}
  const r1 = await s1.result();

  // Brand-new provider instance (simulating a resumed CLI process while Browser Host stays running).
  const provider2 = createCopilotProvider(sharedBrowser);
  const s2 = provider2.streamSimple(
    provider2.getModels()[0],
    normalizeContext({ ...base, messages: [...base.messages, r1, user('Resumed on live tab.')] }),
    { sessionId: 'live-sess' }
  );
  for await (const _ of s2) {}
  const r2 = await s2.result();
  assert.equal(r2.stopReason, 'stop');
  assert.equal(liveRequests[1].request.mode, 'continue');
  assert.equal(liveRequests[1].options.fresh, false);
  assert.deepEqual(liveRequests[1].request.messages.map(textOf), ['Resumed on live tab.']);
});

test('large user input is preserved without an invented browser or conversation limit', async () => {
  const h = harness();
  const messages = [user('x'.repeat(98345))];
  const first = await h.run({ ...base, messages });
  assert.equal(first.stopReason, 'stop');
  assert.deepEqual(h.requests[0].request.messages.map(textOf), ['x'.repeat(98345)]);
  assert.ok(h.requests[0].prompt.length > 98345);
  const next = await h.run({ ...base, messages: [...messages, first, user('y'.repeat(30000))] });
  assert.equal(next.stopReason, 'stop');
  assert.equal(h.requests[1].request.mode, 'continue');
  assert.deepEqual(h.requests[1].request.messages.map(textOf), ['y'.repeat(30000)]);
});

test('a roughly 98K serialized tool result becomes a saved preview without replaying tools or history', async () => {
  const saved = [];
  const h = harness((request, count) => reply(request, count === 1
    ? { type: 'tool_calls', calls: [{ name: 'bash', arguments: { command: 'build' } }] }
    : { type: 'final', lines: ['Build failed; inspect the saved result.'] }), {
    saveToolOutput: async text => { saved.push(text); return 'C:/temp/output.txt'; }
  });
  const first = await h.run();
  const text = 'BEGIN\n' + '"\\'.repeat(24000) + '\nCommand exited with code 1';
  const result = { role: 'toolResult', toolCallId: first.content[0].id, toolName: 'bash',
    isError: true, content: [{ type: 'text', text }], timestamp: 2 };
  const before = structuredClone(result);
  assert.ok(JSON.stringify(result).length > 96000);
  const second = await h.run({ ...base, messages: [...base.messages, first, result] });
  assert.equal(second.stopReason, 'stop');
  assert.deepEqual(result, before);
  assert.deepEqual(saved, [text]);
  const delivered = h.requests[1].request.messages[0];
  assert.equal(delivered.toolCallId, result.toolCallId);
  assert.equal(delivered.isError, true);
  assert.match(textOf(delivered), /BEGIN[\s\S]*Command exited with code 1/);
  assert.match(textOf(delivered), /Partial output[\s\S]*Saved tool result: C:\/temp\/output.txt/);
  assert.ok(h.requests[1].prompt.length < 24000);
  const third = await h.run({ ...base, messages: [...base.messages, first, result, second, user('Next.')] });
  assert.equal(third.stopReason, 'stop');
  assert.deepEqual(h.requests.map(({ request }) => request.mode), ['bootstrap', 'continue', 'continue']);
  assert.deepEqual(h.requests[2].request.messages.map(textOf), ['Next.']);
  assert.equal(saved.length, 1);
});

test('parallel tool results share a budget while retaining every call ID and small result', async () => {
  const saved = [];
  const h = harness((request, count) => reply(request, count === 1
    ? { type: 'tool_calls', calls: Array.from({ length: 8 }, (_, i) => ({ name: 'bash', arguments: { command: `check-${i}` } })) }
    : { type: 'final', lines: ['Checked.'] }), {
    saveToolOutput: async text => { saved.push(text); return `C:/temp/output-${saved.length}.txt`; }
  });
  const first = await h.run();
  const results = first.content.map((call, i) => ({ role: 'toolResult', toolCallId: call.id, toolName: 'bash',
    isError: i === 7, content: [{ type: 'text', text: i ? `CHECK_${i}\n` + Array.from({ length: 1200 }, (_, n) => `row-${n}: quoted "\\🙂`).join('\n') + `\nEND_${i}` : 'Small result.' }], timestamp: 2 }));
  const answer = await h.run({ ...base, messages: [...base.messages, first, ...results] });
  assert.equal(answer.stopReason, 'stop');
  const outgoing = h.requests[1].request.messages;
  assert.deepEqual(outgoing.map(message => message.toolCallId), results.map(message => message.toolCallId));
  assert.deepEqual(outgoing.map(message => message.isError), results.map(message => message.isError));
  assert.equal(textOf(outgoing[0]), 'Small result.');
  assert.equal(saved.length, 7);
  assert.ok(h.requests[1].prompt.length < 24000);
  assert.ok(outgoing.every(message => textOf(message).isWellFormed()));
});
