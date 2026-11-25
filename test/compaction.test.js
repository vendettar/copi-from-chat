import test from 'node:test';
import assert from 'node:assert/strict';
import { compactBootstrapMessages, PROACTIVE_COMPACTION_THRESHOLD, stripPreloadedFileContext } from '../src/compaction.js';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] });
const assistantCall = (id, name, args) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }]
});
const toolResult = (toolCallId, toolName, text, isError = false) => ({
  role: 'toolResult', toolCallId, toolName, isError, content: [{ type: 'text', text }]
});

test('sessions with 12 or fewer messages are not compacted', () => {
  const messages = [];
  for (let i = 0; i < PROACTIVE_COMPACTION_THRESHOLD / 2; i++) {
    messages.push(user(`Prompt ${i}`), assistant(`Answer ${i}`));
  }
  assert.equal(messages.length, 12);
  const result = compactBootstrapMessages(messages);
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test('sessions over 12 messages compact proactively without shortening user instructions or mutating input', () => {
  const longInitial = 'INITIAL_TASK: ' + 'requirement '.repeat(400);
  const longMidUser = 'MID_INSTRUCTION: ' + 'constraint '.repeat(350);
  const messages = [
    user(longInitial),
    assistantCall('c1', 'read', { path: 'src/app.js', offset: 1, limit: 50 }),
    toolResult('c1', 'read', 'console.log("hello");'),
    assistant('Decision: update src/app.js to handle retries cleanly.'),
    user(longMidUser),
    assistantCall('c2', 'edit', { path: 'src/app.js', edits: [] }),
    toolResult('c2', 'edit', 'Edited src/app.js'),
    assistantCall('c3', 'bash', { command: 'npm test' }),
    toolResult('c3', 'bash', 'FAIL test/app.test.js\nAssertionError: expected 2 to equal 1', true),
    assistant('Found failing assertion; fixing edge case.'),
    assistantCall('c4', 'bash', { command: 'npm test' }),
    toolResult('c4', 'bash', '49 passed, 0 failed', false),
    assistant('All tests pass now.'),
    user('Check formatting too.'),
    assistant('Formatting looks good.'),
    user('Prepare final release notes.'),
    assistant('Drafted release notes.'),
    user('Latest follow-up: also update README.md.')
  ];
  assert.ok(messages.length > 12);
  const snapshot = structuredClone(messages);

  const result = compactBootstrapMessages(messages, {
    incompleteCheckpoints: [{ toolName: 'write', toolCallId: 'cp-9', ts: '2026-11-25T10:00:00Z', args: { path: 'src/x.js' } }]
  });

  // Never mutates the caller's transcript copy.
  assert.deepEqual(messages, snapshot);
  assert.equal(result.compacted, true);
  assert.ok(result.messages.length < messages.length);

  // Initial task is kept verbatim as message 0.
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content[0].text, longInitial);

  // Summary captures earlier user instruction verbatim, decisions, paths, tool evidence, errors, checks, and checkpoints.
  const summary = result.messages[1].content[0].text;
  assert.ok(summary.includes(longMidUser), 'Middle user instruction must be preserved verbatim without truncation');
  assert.match(summary, /Key Decisions/);
  assert.match(summary, /src\/app\.js/);
  assert.match(summary, /Tool Execution Evidence/);
  assert.match(summary, /Errors/);
  assert.match(summary, /AssertionError/);
  assert.match(summary, /Check Results/);
  assert.match(summary, /npm test -> FAILED/);
  assert.match(summary, /Interrupted Tool Checkpoints/);
  assert.match(summary, /cp-9/);

  // Latest user prompt is preserved verbatim at the end.
  assert.equal(result.messages.at(-1).content[0].text, 'Latest follow-up: also update README.md.');
});

test('recent turn boundary never orphans a toolResult from its assistant toolCall', () => {
  const messages = [
    user('Start project audit.'),
    assistant('Step 1'),
    user('Run step 2'),
    assistant('Step 2 done'),
    user('Run step 3'),
    assistant('Step 3 done'),
    user('Run batch'),
    assistantCall('b1', 'read', { path: 'a.js' }),
    toolResult('b1', 'read', 'a'),
    assistantCall('b2', 'read', { path: 'b.js' }),
    toolResult('b2', 'read', 'b'),
    assistantCall('b3', 'read', { path: 'c.js' }),
    toolResult('b3', 'read', 'c'),
    user('Summarize findings.')
  ];

  const result = compactBootstrapMessages(messages, { keepRecent: 5 });
  assert.equal(result.compacted, true);
  // Ensure the first message after the summary is never a bare toolResult.
  assert.notEqual(result.messages[2].role, 'toolResult');
});

test('compaction strips stale preloaded file dumps from older messages while keeping user text and latest preload intact', () => {
  const preloadDump = '\n\n[Preloaded file context — already read locally, no need to re-read these sections]\n--- src/stale.js ---\n' + 'const old = 1;\n'.repeat(200);
  const latestPreload = '\n\n[Preloaded file context — already read locally, no need to re-read these sections]\n--- src/fresh.js ---\nexport const fresh = true;';

  const stripped = stripPreloadedFileContext('Fix src/stale.js' + preloadDump);
  assert.match(stripped, /^Fix src\/stale\.js\n\[earlier preloaded files omitted during compaction: src\/stale\.js\]$/);

  const messages = [
    user('Initial goal.' + preloadDump),
    assistant('Started.'),
    user('Middle task.' + preloadDump),
    assistant('Middle done.'),
    user('Step 3.'),
    assistant('Step 3 done.'),
    user('Step 4.'),
    assistantCall('t1', 'read', { path: 'src/big.js' }),
    toolResult('t1', 'read', 'BIG_HEAD\n' + 'x'.repeat(4000) + '\nBIG_TAIL'),
    assistant('Read big file.'),
    user('Step 5.'),
    assistant('Step 5 done.'),
    user('Current task.' + latestPreload)
  ];

  const result = compactBootstrapMessages(messages, { threshold: 10, keepRecent: 6 });
  assert.equal(result.compacted, true);
  // Initial message keeps exact typed instruction but drops stale 3KB preload dump.
  assert.ok(result.messages[0].content[0].text.startsWith('Initial goal.'));
  assert.doesNotMatch(result.messages[0].content[0].text, /const old = 1/);
  // Summary keeps middle instruction verbatim without stale preload dump.
  assert.match(result.messages[1].content[0].text, /Middle task\./);
  assert.doesNotMatch(result.messages[1].content[0].text, /const old = 1/);
  // Stale oversized toolResult inside recent is trimmed.
  const recentRead = result.messages.find(m => m.role === 'toolResult');
  assert.match(recentRead.content[0].text, /trimmed from older toolResult during compaction/);
  assert.ok(recentRead.content[0].text.length < 2200);
  // Latest user prompt retains its fresh preloaded context verbatim!
  assert.match(result.messages.at(-1).content[0].text, /export const fresh = true;/);
});
