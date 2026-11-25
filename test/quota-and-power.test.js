import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { normalizeContext } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  compactWireSystemPrompt, compactWireTools, createCopilotProvider, parseReply, promptFor
} from '../src/pi-provider.js';
import { createRuntime } from '../src/runtime.js';
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

test('lean continue header, compact bootstrap wire schemas, and <docs> stripping drastically reduce wire overhead', () => {
  const contPrompt = promptFor({
    mode: 'continue',
    requestId: 'req-123',
    sessionId: 's-1',
    previousRequestId: 'req-122',
    messages: [{ role: 'user', content: 'hi' }]
  });
  // Header without JSON payload should be ~450-550 chars (down from 3,115 chars in v0.1.0).
  const contHeader = contPrompt.split('\nTASK_CONTEXT_JSON:\n')[0];
  assert.ok(contHeader.length < 650, `Expected continue header < 650 chars, got ${contHeader.length}`);
  assert.match(contPrompt, /\nTASK_CONTEXT_JSON:\n/);
  assert.match(contPrompt, /<<<COPILOT_REPLY_START:req-123>>>/);

  const bloatedSys = 'Intro.\n\n<tools>\n- read: Read\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n<docs>\nPi docs: ' + 'x'.repeat(1200) + '\n</docs>\n\n<addendum>\nKeep this.\n</addendum>';
  const compactSys = compactWireSystemPrompt(bloatedSys);
  assert.doesNotMatch(compactSys, /<docs>|<tools>/);
  assert.match(compactSys, /<rules>[\s\S]*Be concise/);
  assert.match(compactSys, /<addendum>[\s\S]*Keep this/);
  assert.ok(compactSys.length < 250);

  const verboseTools = [{
    name: 'read',
    description: 'Read the contents of a file. Supports text files and images (jpg, png). Output is truncated to 2000 lines.',
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', description: 'Path to file' } }
    }
  }];
  const compactTools = compactWireTools(verboseTools);
  assert.equal(compactTools[0].constrainedSampling, undefined);
  assert.equal(compactTools[0].parameters.additionalProperties, undefined);
  assert.doesNotMatch(compactTools[0].description, /images/);
});

test('plain workspace paths auto-preload without @ (including CJK boundaries) while skipping URLs, emails, and ignored dirs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-auto-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(root, 'src/app.js'), 'export const answer = 42;\nexport const extra = 99;\n');
  await writeFile(join(root, 'package.json'), '{"name":"plain-demo"}\n');
  await writeFile(join(root, 'node_modules/pkg/dep.js'), 'export const dep = true;\n');

  const res = await expandFileMentions(
    '请修复src/app.js:1-1里的问题，顺便看下 package.json，忽略 https://example.com/src/app.js、user@example.com 和 node_modules/pkg/dep.js',
    root
  );
  assert.deepEqual(res.loadedFiles, ['src/app.js (lines 1-1)', 'package.json']);
  assert.match(res.text, /1: export const answer = 42;/);
  assert.match(res.text, /"name":"plain-demo"/);
  assert.doesNotMatch(res.text, /export const dep/);
});

test('sequential tool execution runs [write, edit, bash] in strict order within ONE web turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-seq-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);

  let askCount = 0;
  let capturedResults = [];
  const rt = await createRuntime({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    preloadWorkspace: false,
    browser: {
      async ask(prompt) {
        askCount++;
        const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
        if (askCount === 1) {
          // Single web turn chaining write -> edit -> bash cat!
          return mkReply(req, {
            type: 'tool_calls',
            calls: [
              { name: 'write', arguments: { path: 'seq.txt', content: 'step-one\n' } },
              { name: 'edit', arguments: { path: 'seq.txt', edits: [{ oldText: 'step-one', newText: 'step-two' }] } },
              { name: 'bash', arguments: { command: 'cat seq.txt' } }
            ]
          });
        }
        capturedResults = req.messages.filter(m => m.role === 'toolResult');
        return mkReply(req, { type: 'final', lines: ['All 3 steps verified in one turn.'] });
      },
      async close() {}
    }
  });
  await rt.session.bindExtensions({});
  await rt.session.prompt('Create, edit, and verify seq.txt.');
  assert.equal(askCount, 2); // Only 2 web turns total instead of 4!
  assert.equal(capturedResults.length, 3);
  assert.ok(capturedResults.every(r => !r.isError));
  assert.match(capturedResults[2].content[0].text, /step-two/);
  assert.equal(await readFile(join(cwd, 'seq.txt'), 'utf8'), 'step-two\n');
});

test('same-tab unchanged read deduplication omits repeated file bodies and char-budget rotation refreshes the tab', async () => {
  const readTool = {
    name: 'read',
    description: 'Read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  };
  const body = 'line\n'.repeat(200); // 1000 chars (> 400 dedup threshold)
  const modifiedBody = 'changed\n'.repeat(120);
  const requests = [];
  const control = {};
  const provider = createCopilotProvider({
    async ask(prompt, options) {
      const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      requests.push({ req, fresh: options.fresh, promptLen: prompt.length });
      if (requests.length === 1 || requests.length === 3 || requests.length === 5) {
        return mkReply(req, { type: 'tool_calls', calls: [{ name: 'read', arguments: { path: 'src/big.js' } }] });
      }
      return mkReply(req, { type: 'final', lines: ['ok'] });
    }
  }, {
    autoRotateTurns: 25,
    autoRotateChars: 3500,
    minTurnsForCharRotate: 4,
    control
  });

  const run = async msgs => {
    const s = provider.streamSimple(provider.getModels()[0], normalizeContext({ systemPrompt: 'Work.', messages: msgs, tools: [readTool] }), { sessionId: 'dedup-s' });
    for await (const _ of s) {}
    return s.result();
  };

  let msgs = [user('First read')];
  const a1 = await run(msgs);
  const tr1 = { role: 'toolResult', toolCallId: a1.content[0].id, toolName: 'read', isError: false, content: [{ type: 'text', text: body }], timestamp: 2 };
  msgs = [...msgs, a1, tr1];
  const a2 = await run(msgs);
  assert.equal(requests[1].req.messages[0].content[0].text, body); // 1st read sent in full

  // 2nd identical read in SAME tab -> deduped to 1-line stub!
  msgs = [...msgs, a2, user('Read again')];
  const a3 = await run(msgs);
  const tr2 = { role: 'toolResult', toolCallId: a3.content[0].id, toolName: 'read', isError: false, content: [{ type: 'text', text: body }], timestamp: 3 };
  msgs = [...msgs, a3, tr2];
  const a4 = await run(msgs);
  assert.match(requests[3].req.messages[0].content[0].text, /Already read in this web conversation/);

  // 3rd read with MODIFIED file content -> sent in full!
  msgs = [...msgs, a4, user('Read modified')];
  const a5 = await run(msgs);
  // Note: by now webTurnsInTab >= 4 AND webCharsInTab >= 3500, so this user boundary rotated to a fresh tab!
  assert.equal(requests[4].fresh, true);
  assert.equal(requests[4].req.mode, 'bootstrap');

  const tr3 = { role: 'toolResult', toolCallId: a5.content[0].id, toolName: 'read', isError: false, content: [{ type: 'text', text: modifiedBody }], timestamp: 4 };
  msgs = [...msgs, a5, tr3];
  await run(msgs);
  assert.equal(requests[5].req.messages[0].content[0].text, modifiedBody);
});
