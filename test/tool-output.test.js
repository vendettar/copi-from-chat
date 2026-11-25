import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { denoiseToolOutput, limitToolResults, PER_RESULT_TOOL_TEXT_BUDGET, TOOL_TEXT_BUDGET } from '../src/tool-output.js';

test('saved results preserve the complete returned text and stay within the ~5,000 per-result limit', async t => {
  const text = 'first line\r\n' + '"\\🙂'.repeat(20000) + '\n[Earlier truncation: original log is elsewhere.]';
  const messages = [{ role: 'toolResult', toolCallId: 'call-0', toolName: 'read', isError: false,
    content: [{ type: 'text', text }] }];
  const limited = await limitToolResults(messages);
  const preview = limited[0].content[0].text;
  const path = preview.match(/\nSaved tool result: (.+)\n/)[1];
  t.after(() => rm(path, { force: true }));
  assert.equal(await readFile(path, 'utf8'), text);
  assert.match(preview, /Earlier truncation: original log is elsewhere/);
  assert.ok(preview.isWellFormed());
  assert.ok(JSON.stringify(limited[0].content).length <= PER_RESULT_TOOL_TEXT_BUDGET);
  assert.equal(messages[0].content[0].text, text);
});

test('a single ~7,000-char tool result is proactively shortened to ~5,000 while full output is saved', async () => {
  const saved = [];
  const text = 'HEAD\n' + 'a'.repeat(7000) + '\nTAIL';
  const messages = [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
    content: [{ type: 'text', text }] }];
  const limited = await limitToolResults(messages, {
    save: async content => { saved.push(content); return 'C:/temp/single.txt'; }
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0], text);
  assert.ok(JSON.stringify(limited[0].content).length <= PER_RESULT_TOOL_TEXT_BUDGET);
  assert.match(limited[0].content[0].text, /HEAD[\s\S]*TAIL/);
  assert.match(limited[0].content[0].text, /Saved tool result: C:\/temp\/single\.txt/);
});

test('tool-result batches share the ~10,000 JSON character budget while keeping small results whole', async () => {
  const saved = [];
  const messages = [
    { role: 'toolResult', toolCallId: 'c0', toolName: 'read', isError: false, content: [{ type: 'text', text: 'tiny' }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'B1\n' + 'x'.repeat(4500) + '\nE1' }] },
    { role: 'toolResult', toolCallId: 'c2', toolName: 'read', isError: false, content: [{ type: 'text', text: 'B2\n' + 'y'.repeat(4500) + '\nE2' }] },
    { role: 'toolResult', toolCallId: 'c3', toolName: 'read', isError: false, content: [{ type: 'text', text: 'B3\n' + 'z'.repeat(4500) + '\nE3' }] }
  ];
  const limited = await limitToolResults(messages, {
    save: async content => { saved.push(content); return `C:/temp/batch-${saved.length}.txt`; }
  });
  assert.equal(limited[0].content[0].text, 'tiny');
  assert.equal(saved.length, 3);
  const totalJson = limited.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);
  assert.ok(totalJson <= TOOL_TEXT_BUDGET, `Expected <= ${TOOL_TEXT_BUDGET}, got ${totalJson}`);
});

test('small results and arbitrarily large user messages are neither shortened nor saved', async () => {
  const messages = [{ role: 'user', content: 'x'.repeat(100000) },
    { role: 'toolResult', content: [{ type: 'text', text: 'Small.' }] }];
  const limited = await limitToolResults(messages, { save: () => { throw new Error('Must not save'); } });
  assert.equal(limited, messages);
});

test('an aborted exchange does not save tool output', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(limitToolResults([{ role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(50000) }] }], {
    signal: controller.signal, save: () => { throw new Error('Must not save'); }
  }), { name: 'AbortError' });
});

test('bash output is denoised (ANSI, progress bars, duplicate lines) before budgeting while read output stays verbatim', async () => {
  const noisy = [
    '\x1b[32mPASS\x1b[0m suite',
    'Loading 10%\rLoading 50%\rLoading 100%',
    ...Array(200).fill('Warning: deprecated API call'),
    'Done.'
  ].join('\n');

  const denoised = denoiseToolOutput(noisy);
  assert.doesNotMatch(denoised, /\x1b\[/);
  assert.match(denoised, /PASS suite/);
  assert.match(denoised, /Loading 100%/);
  assert.doesNotMatch(denoised, /Loading 10%/);
  assert.match(denoised, /\[\.\.\. repeated 199 more times \.\.\.\]/);

  // Denoising shrinks noisy bash output below the 5K cap so no temp file save or follow-up read turn is needed!
  let saved = 0;
  const bashResult = [{ role: 'toolResult', toolCallId: 'b1', toolName: 'bash', isError: false, content: [{ type: 'text', text: noisy }] }];
  const limitedBash = await limitToolResults(bashResult, { save: async () => { saved++; return 'C:/temp/unused.txt'; } });
  assert.equal(saved, 0);
  assert.equal(limitedBash[0].content[0].text, denoised);

  // Read results must NEVER be denoised so exact-match edit targets stay intact.
  const readSource = 'const a = "\\x1b[32m";\n' + 'same line\n'.repeat(10);
  const readResult = [{ role: 'toolResult', toolCallId: 'r1', toolName: 'read', isError: false, content: [{ type: 'text', text: readSource }] }];
  const limitedRead = await limitToolResults(readResult, { save: async () => { throw new Error('Must not save'); } });
  assert.equal(limitedRead[0].content[0].text, readSource);
});
