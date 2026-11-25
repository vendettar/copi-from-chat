import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createCopilotProvider, parseReply } from '../src/pi-provider.js';
import { exportSessionToFile } from '../src/export.js';
import { ensureCopiDirs, getCopiPaths } from '../src/paths.js';
import { runPostEditSyntaxCheck } from '../src/post-edit-check.js';
import { collectWorkspaceSnapshot, expandFileMentions } from '../src/precontext.js';
import { loadPromptTemplates, renderPromptTemplate } from '../src/prompts.js';
import { detectWebLimitNotice, formatQuotaShort, markThinkLimitedToday, readTodayQuota, recordWebTurn } from '../src/quota.js';
import { createSearchTools } from '../src/search-tools.js';
import { createUndoManager } from '../src/undo.js';

const exec = promisify(execFile);
const user = text => ({ role: 'user', content: text, timestamp: 1 });
const base = { systemPrompt: 'Use local tools.', messages: [user('Analyze this.')], tools: [] };
const mkReply = (req, value) => {
  const text = JSON.stringify({ requestId: req.requestId, ...value });
  return { completed: true, text, codeBlocks: [text] };
};

test('quota tracking persists daily turn counts and detects English/Chinese daily & conversation limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));

  assert.equal(detectWebLimitNotice('You have reached your daily limit for Think deeper. Try again tomorrow.').kind, 'daily_limit');
  assert.equal(detectWebLimitNotice('您已达到今日深度思考使用上限，请明天再试。').kind, 'daily_limit');
  assert.equal(detectWebLimitNotice('This conversation has reached its limit. Please start a new chat.').kind, 'conversation_limit');
  assert.equal(detectWebLimitNotice('本对话已达上限，请开启新对话。').kind, 'conversation_limit');
  // Normal protocol replies mentioning "daily limit" in code/prose must not trigger limit detection.
  assert.equal(detectWebLimitNotice('<<<COPILOT_REPLY_START:r1>>>\n{"requestId":"r1","type":"final","lines":["daily limit"]}').limited, false);

  await recordWebTurn(paths, { kind: 'preset', name: 'think' });
  await recordWebTurn(paths, { kind: 'preset', name: 'quick' });
  await recordWebTurn(paths, { kind: 'preset', name: 'quick' });
  const q1 = await readTodayQuota(paths);
  assert.equal(q1.counts.total, 3);
  assert.equal(q1.counts.think, 1);
  assert.equal(q1.counts.quick, 2);
  assert.match(formatQuotaShort(q1), /today: 3 \(1t\/2q\)/);

  const q2 = await markThinkLimitedToday(paths);
  assert.equal(q2.thinkLimited, true);
  assert.match(formatQuotaShort(q2), /\[think cap\]/);
});

test('provider smart tiering uses quick on toolResult turns, auto-downgrades on Think daily limit, and rotates on conversation limit', async () => {
  const seen = [];
  let thinkLimitedFlag = false;
  const tool = { name: 'bash', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };

  const provider = createCopilotProvider({
    async ask(prompt, options) {
      const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      seen.push({ mode: req.mode, fresh: options.fresh, modelPreference: options.modelPreference, isToolResultTurn: options.turnContext?.isToolResultTurn });
      if (seen.length === 1) {
        return mkReply(req, { type: 'tool_calls', calls: [{ name: 'bash', arguments: { command: 'echo ok' } }] });
      }
      if (seen.length === 2) {
        return mkReply(req, { type: 'final', lines: ['Step 1 done.'] });
      }
      if (seen.length === 3) {
        // Simulate M365 Think deeper daily-limit response on turn 2!
        return { completed: true, text: 'You have reached your daily limit for Think deeper. Try again tomorrow.' };
      }
      if (seen.length === 5) {
        // Simulate M365 conversation limit banner!
        return { completed: true, text: 'This conversation has reached its limit. Please start a new chat.' };
      }
      return mkReply(req, { type: 'final', lines: ['Recovered cleanly.'] });
    }
  }, {
    getModelPreference: () => ({ kind: 'preset', name: 'smart' }),
    getQuotaState: async () => ({ thinkLimited: thinkLimitedFlag }),
    onThinkLimited: async () => { thinkLimitedFlag = true; }
  });

  const run = async ctx => {
    const s = provider.streamSimple(provider.getModels()[0], normalizeContext(ctx), { sessionId: 'smart-s1' });
    for await (const _ of s) {}
    return s.result();
  };

  // Turn 1 main prompt -> think; toolResult follow-up -> quick!
  const ctx1 = { systemPrompt: 'Work.', messages: [user('Run echo')], tools: [tool] };
  const r1 = await run(ctx1);
  assert.equal(r1.stopReason, 'toolUse');
  assert.equal(seen[0].modelPreference.name, 'think');

  const tr = { role: 'toolResult', toolCallId: r1.content[0].id, toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }], timestamp: 2 };
  const r2 = await run({ ...ctx1, messages: [...ctx1.messages, r1, tr] });
  assert.equal(r2.stopReason, 'stop');
  assert.equal(seen[1].modelPreference.name, 'quick');
  assert.equal(seen[1].isToolResultTurn, true);

  // Turn 2 hits Think daily limit -> automatically downgrades to quick on a fresh tab and succeeds!
  const r3 = await run({ ...ctx1, messages: [...ctx1.messages, r1, tr, r2, user('Next task')] });
  assert.equal(r3.stopReason, 'stop');
  assert.equal(thinkLimitedFlag, true);
  assert.equal(seen[2].modelPreference.name, 'think');
  assert.equal(seen[3].modelPreference.name, 'quick');
  assert.equal(seen[3].fresh, true);

  // Turn 3 hits conversation limit -> automatically rotates to a fresh tab and succeeds!
  const r4 = await run({ ...ctx1, messages: [...ctx1.messages, r1, tr, r2, user('Next task'), r3, user('Another task')] });
  assert.equal(r4.stopReason, 'stop');
  assert.equal(seen[4].modelPreference.name, 'quick');
  assert.equal(seen[5].fresh, true);
});

test('parseReply recovers trailing commas and allows clean plain-text final answers without wasting a repair turn', () => {
  const trailing = '{"requestId":"r1","type":"final","lines":["hello",],}';
  assert.equal(parseReply({ completed: true, text: trailing, codeBlocks: [trailing] }, 'r1', []).text, 'hello');

  const plain = parseReply({ completed: true, text: 'Here is the direct explanation.' }, 'r2', [], { allowPlainTextFinal: true });
  assert.equal(plain.type, 'final');
  assert.equal(plain.text, 'Here is the direct explanation.');
  assert.equal(plain.recoveredPlainText, true);

  // Broken tool_calls attempt must NOT be accepted as plain-text final!
  assert.throws(
    () => parseReply({ completed: true, text: '{"requestId":"r3","type":"tool_calls","calls":[broken' }, 'r3', [], { allowPlainTextFinal: true }),
    { code: 'COPILOT_REPLY_FORMAT' }
  );
});

test('zero-turn workspace snapshot, @file preloading, and local post-edit syntax check work with zero web quota', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-prectx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }));
  await writeFile(join(root, 'src', 'good.js'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
  await writeFile(join(root, 'src', 'bad.js'), 'export const broken = (\n');
  await writeFile(join(root, 'src', 'bad.json'), '{ invalid }');

  const snap = await collectWorkspaceSnapshot(root);
  assert.match(snap, /package\.json: demo@1\.0\.0/);
  assert.match(snap, /src\/good\.js/);

  const expanded = await expandFileMentions('Check @src/good.js:1-2 and ignore user@example.com and @../escape.js', root);
  assert.deepEqual(expanded.loadedFiles, ['src/good.js (lines 1-2)']);
  assert.match(expanded.text, /1: export const x = 1;/);
  assert.doesNotMatch(expanded.text, /3: export const z = 3;/);

  assert.equal((await runPostEditSyntaxCheck('src/good.js', root)).ok, true);
  assert.equal((await runPostEditSyntaxCheck('src/bad.js', root)).ok, false);
  assert.equal((await runPostEditSyntaxCheck('src/bad.json', root)).ok, false);
  assert.equal((await runPostEditSyntaxCheck('package.json', root)).ok, true);
});

test('undo manager snapshots pre-edit states per turn and reverts modified and created files cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-undo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'existing.txt'), 'original\n');

  const undo = createUndoManager(root);
  undo.beginTurn();
  await undo.captureBeforeModify('existing.txt');
  await writeFile(join(root, 'existing.txt'), 'edit 1\n');
  // Second edit in same turn must keep original pre-turn content, not edit 1!
  await undo.captureBeforeModify('existing.txt');
  await writeFile(join(root, 'existing.txt'), 'edit 2\n');
  await undo.captureBeforeModify('created.txt');
  await writeFile(join(root, 'created.txt'), 'brand new\n');
  undo.commitTurn();

  assert.equal(undo.peekLastTurn().files.length, 2);
  const res = await undo.undoLastTurn();
  assert.equal(res.undone, true);
  assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'original\n');
  await assert.rejects(readFile(join(root, 'created.txt'), 'utf8'), { code: 'ENOENT' });
});

test('non-Git search fallback finds and greps files respecting .gitignore and skipping node_modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-nongit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(root, '.gitignore'), 'ignored.log\n');
  await writeFile(join(root, 'src/index.js'), 'const marker = "FIND_ME";\n');
  await writeFile(join(root, 'ignored.log'), 'FIND_ME ignored\n');
  await writeFile(join(root, 'node_modules/pkg/index.js'), 'FIND_ME in deps\n');

  const tools = Object.fromEntries(createSearchTools(root, { allowNonGitFallback: true }).map(tool => [tool.name, tool]));
  const found = (await tools.find.execute('1', { pattern: '*.js' })).content[0].text;
  assert.equal(found, 'src/index.js');
  const grepped = (await tools.grep.execute('2', { pattern: 'FIND_ME' })).content[0].text;
  assert.match(grepped, /src\/index\.js:1:/);
  assert.doesNotMatch(grepped, /ignored\.log|node_modules/);
});

test('custom prompt templates and Markdown session export work cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-prompts-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const copiHome = join(root, 'copi-home');
  await mkdir(join(cwd, '.copi', 'prompts'), { recursive: true });
  await exec('git', ['init', '-q'], { cwd });
  await writeFile(join(cwd, '.copi', 'prompts', 'audit.md'), '# Security audit\nFocus: {{args}} on branch {{branch}}');
  const paths = await ensureCopiDirs(getCopiPaths(copiHome));

  const templates = await loadPromptTemplates({ copiPaths: paths, cwd });
  const audit = templates.find(item => item.name === 'audit');
  assert.ok(audit);
  assert.ok(templates.some(item => item.name === 'review'));
  const rendered = await renderPromptTemplate(audit, { args: 'auth.js', cwd });
  assert.match(rendered, /Focus: auth\.js on branch/);

  const exported = await exportSessionToFile({
    cwd,
    sessionId: 'sess-export-1',
    sessionName: 'Quota Upgrade',
    messages: [
      { role: 'user', content: 'Optimize quota usage.' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'src/a.js' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] }
    ]
  });
  const md = await readFile(exported.path, 'utf8');
  assert.match(md, /# Copi Session Export — Quota Upgrade/);
  assert.match(md, /`src\/a\.js`/);
  assert.match(md, /### You[\s\S]*Optimize quota usage/);
  assert.match(md, /### Copi[\s\S]*All done/);
});
