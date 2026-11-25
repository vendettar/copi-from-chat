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
import { buildEditFailureHint, runPostEditSyntaxCheck } from '../src/post-edit-check.js';
import { collectWorkspaceSnapshot, expandFileMentions } from '../src/precontext.js';
import { loadPromptTemplates, renderPromptTemplate } from '../src/prompts.js';
import { detectWebLimitNotice, formatQuotaShort, markThinkLimitedToday, readTodayQuota, recordWebTurn } from '../src/quota.js';
import { createSearchTools } from '../src/search-tools.js';
import { createUndoManager } from '../src/undo.js';
import { compareSemver, runUpgrade } from '../src/upgrade.js';

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

  // Un-fenced Markdown smart quotes (“ / ”) and raw newlines in read-only final replies recover locally at 0 quota!
  const smartQuotedFinal = '<<<COPILOT_REPLY_START:r4>>>\n{“requestId”:“r4”,“type”:“final”,“lines”:[“Recovered smart quotes.”]}\n<<<COPILOT_REPLY_END:r4>>>';
  const recoveredSmart = parseReply({ completed: true, text: smartQuotedFinal, codeBlocks: [] }, 'r4', []);
  assert.equal(recoveredSmart.type, 'final');
  assert.equal(recoveredSmart.text, 'Recovered smart quotes.');

  // Smart quotes inside tool_calls must NEVER be guessed (safety first)!
  const smartQuotedTool = '<<<COPILOT_REPLY_START:r5>>>\n{“requestId”:“r5”,“type”:“tool_calls”,“calls”:[{“name”:“bash”,“arguments”:{“command”:“echo hi”}}]}\n<<<COPILOT_REPLY_END:r5>>>';
  assert.throws(
    () => parseReply({ completed: true, text: smartQuotedTool, codeBlocks: [] }, 'r5', [{ name: 'bash' }]),
    error => error.code === 'COPILOT_REPLY_FORMAT' && /error="[^"]+"/.test(error.message)
  );

  // Raw control newline inside a JSON string (from un-fenced Markdown) recovers cleanly!
  const rawNewlineJson = '<<<COPILOT_REPLY_START:r6>>>\n{"requestId":"r6","type":"final","text":"line 1\nline 2"}\n<<<COPILOT_REPLY_END:r6>>>';
  const recoveredNewline = parseReply({ completed: true, text: rawNewlineJson, codeBlocks: [] }, 'r6', []);
  assert.equal(recoveredNewline.text, 'line 1\nline 2');
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
  assert.match(contPrompt, /```json/);

  assert.throws(
    () => parseReply({ completed: true, text: '<<<COPILOT_REPLY_START:r1>>>\n{"requestId":"r1","type":"tool_calls","calls":[{"name":"bash","arguments":{"command":"python -c "p=1""}}]}\n<<<COPILOT_REPLY_END:r1>>>', codeBlocks: [] }, 'r1', [{ name: 'bash' }]),
    error => error.code === 'COPILOT_REPLY_FORMAT' && /Missing ```json code fence/.test(error.message)
  );

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

test('edit-failure recovery attaches closest current lines (and ambiguous line numbers) locally with 0 quota', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-edit-hint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);

  const lines = Array.from({ length: 40 }, (_, i) => `export const item${i + 1} = ${i + 1};`);
  lines[24] = 'export function computeTotal(price, tax) { return price + tax; }';
  lines[25] = 'export const dupValue = 1;';
  lines[30] = 'export const dupValue = 1;';
  await writeFile(join(cwd, 'calc.js'), `${lines.join('\n')}\n`);

  // Case 1: Fuzzy-locate closest region when oldText has wrong whitespace/arg name.
  const fuzzyHint = await buildEditFailureHint({
    path: 'calc.js',
    edits: [{ oldText: 'export function computeTotal(price, fee) { return price + fee; }', newText: 'x' }]
  }, cwd);
  assert.match(fuzzyHint, /Local edit recovery/);
  assert.match(fuzzyHint, /25: export function computeTotal\(price, tax\)/);

  // Case 2: Ambiguous multiple matches -> reports exact match line numbers.
  const multiHint = await buildEditFailureHint({
    path: 'calc.js',
    edits: [{ oldText: 'export const dupValue = 1;', newText: 'export const dupValue = 2;' }]
  }, cwd);
  assert.match(multiHint, /matched 2 places.*26, 31/);

  // Case 3: End-to-end inside runtime tool_result hook on a failed edit!
  let capturedError = '';
  let turn = 0;
  const rt = await createRuntime({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    preloadWorkspace: false,
    browser: {
      async ask(prompt) {
        turn++;
        const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
        if (turn === 1) {
          return mkReply(req, {
            type: 'tool_calls',
            calls: [{
              name: 'edit',
              arguments: {
                path: 'calc.js',
                edits: [{ oldText: 'export function computeTotal(price, wrongArg) { return price + wrongArg; }', newText: 'export function computeTotal(a, b) { return a + b; }' }]
              }
            }]
          });
        }
        capturedError = req.messages.find(m => m.role === 'toolResult')?.content?.[0]?.text ?? '';
        return mkReply(req, { type: 'final', lines: ['Saw recovery snippet.'] });
      },
      async close() {}
    }
  });
  await rt.session.bindExtensions({});
  await rt.session.prompt('Edit computeTotal.');
  assert.match(capturedError, /Local edit recovery/);
  assert.match(capturedError, /25: export function computeTotal\(price, tax\)/);
});

test('post-edit syntax check supports TypeScript and Python without creating __pycache__', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-lang-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'good.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  await writeFile(join(root, 'bad.ts'), 'export function broken(a: number { return a; }\n');
  await writeFile(join(root, 'good.py'), 'def add(a: int, b: int) -> int:\n    return a + b\n');
  await writeFile(join(root, 'bad.py'), 'def broken(a:\n    return a\n');

  const goodTs = await runPostEditSyntaxCheck('good.ts', root);
  if (goodTs) {
    assert.equal(goodTs.ok, true);
    const badTs = await runPostEditSyntaxCheck('bad.ts', root);
    assert.equal(badTs?.ok, false);
    assert.match(badTs.note, /TS SYNTAX ERROR/);
  }

  const goodPy = await runPostEditSyntaxCheck('good.py', root);
  if (goodPy) {
    assert.equal(goodPy.ok, true);
    const badPy = await runPostEditSyntaxCheck('bad.py', root);
    assert.equal(badPy?.ok, false);
    assert.match(badPy.note, /PYTHON SYNTAX ERROR/);
    // Must not leave __pycache__ behind!
    await assert.rejects(readFile(join(root, '__pycache__')), { code: 'ENOENT' });
  }
});

test('short monotonic requestIds recover gracefully when model mistypes/echoes previousRequestId on a new reply, while identical stale replies hard-stop', async () => {
  const seen = [];
  let turn1Reply;
  const provider = createCopilotProvider({
    async ask(prompt, options) {
      const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      seen.push({ req, options });
      if (seen.length === 1) {
        const json = JSON.stringify({ requestId: req.requestId, type: 'final', lines: ['First answer.'] });
        turn1Reply = {
          completed: true,
          text: `<<<COPILOT_REPLY_START:${req.requestId}>>>\n${json}\n<<<COPILOT_REPLY_END:${req.requestId}>>>`,
          codeBlocks: [json]
        };
        return turn1Reply;
      }
      if (seen.length === 2) {
        // Brand-new reply text, but model accidentally echoed previousRequestId in markers & JSON!
        const wrongId = req.previousRequestId;
        const json = JSON.stringify({ requestId: wrongId, type: 'final', lines: ['Second answer with echoed ID.'] });
        return {
          completed: true,
          text: `<<<COPILOT_REPLY_START:${wrongId}>>>\n${json}\n<<<COPILOT_REPLY_END:${wrongId}>>>`,
          codeBlocks: [json]
        };
      }
      if (seen.length === 3) {
        // Repair succeeds with the NEW requestId!
        const json = JSON.stringify({ requestId: req.requestId, type: 'final', lines: ['Second answer fixed.'] });
        return {
          completed: true,
          text: `<<<COPILOT_REPLY_START:${req.requestId}>>>\n${json}\n<<<COPILOT_REPLY_END:${req.requestId}>>>`,
          codeBlocks: [json]
        };
      }
      // Turn 3 simulates an IDENTICAL stale bubble from turn 2 -> must hard-stop without repair!
      const prevJson = JSON.stringify({ requestId: seen[2].req.requestId, type: 'final', lines: ['Second answer fixed.'] });
      return {
        completed: true,
        text: `<<<COPILOT_REPLY_START:${seen[2].req.requestId}>>>\n${prevJson}\n<<<COPILOT_REPLY_END:${seen[2].req.requestId}>>>`,
        codeBlocks: [prevJson]
      };
    }
  });

  const run = async msgs => {
    const s = provider.streamSimple(provider.getModels()[0], normalizeContext({ systemPrompt: 'Work.', messages: msgs, tools: [] }), { sessionId: 'reqid-s' });
    for await (const _ of s) {}
    return s.result();
  };

  const r1 = await run([user('Turn 1')]);
  assert.equal(r1.stopReason, 'stop');
  assert.match(seen[0].req.requestId, /^r1-[0-9a-f]{4}$/);

  // Turn 2: model echoed previousRequestId on a brand-new reply -> auto-repaired cleanly in 1 repair pass!
  const r2 = await run([user('Turn 1'), r1, user('Turn 2')]);
  assert.equal(r2.stopReason, 'stop');
  assert.equal(r2.content[0].text, 'Second answer fixed.');
  assert.equal(seen[1].options.previousRequestId, seen[0].req.requestId);
  assert.equal(seen[2].req.mode, 'repair');
  assert.match(seen[2].req.requestId, /^r3-[0-9a-f]{4}$/);

  // Turn 3: exact identical stale reply returned -> hard-stops immediately WITHOUT burning a repair turn!
  const r3 = await run([user('Turn 1'), r1, user('Turn 2'), r2, user('Turn 3')]);
  assert.equal(r3.stopReason, 'error');
  assert.match(r3.errorMessage, /Reply markers belong to a different request/);
  assert.equal(seen.length, 4);
});

test('copi upgrade compares semver, preserves Edge when up-to-date, and stops Browser Host before installing newer .tgz', async () => {
  assert.equal(compareSemver('0.2.0', '0.1.6'), 1);
  assert.equal(compareSemver('0.2.0', '0.2.0'), 0);
  assert.equal(compareSemver('0.1.9', '0.2.0'), -1);

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v0.2.0',
      name: 'v0.2.0 — Power Upgrade',
      html_url: 'https://github.com/vendettar/copi-from-chat/releases/tag/v0.2.0',
      assets: [{ name: 'copi-from-chat-0.2.0.tgz', browser_download_url: 'https://example.test/copi-0.2.0.tgz' }]
    })
  });

  // Case 1: Already at latest -> must NOT stop Browser Host!
  let stopped = 0;
  let installed = null;
  const noopLog = () => {};
  const same = await runUpgrade({
    paths: { browserHostFile: '/tmp/unused' },
    currentVersion: '0.2.0',
    fetchImpl: mockFetch,
    stopHost: async () => { stopped++; return { stopped: true }; },
    installPackage: async url => { installed = url; },
    log: noopLog
  });
  assert.equal(same.alreadyLatest, true);
  assert.equal(stopped, 0);
  assert.equal(installed, null);

  // Case 2: --check reports update available without stopping host or installing.
  const checked = await runUpgrade({
    paths: { browserHostFile: '/tmp/unused' },
    currentVersion: '0.1.6',
    checkOnly: true,
    fetchImpl: mockFetch,
    stopHost: async () => { stopped++; return { stopped: true }; },
    installPackage: async url => { installed = url; },
    log: noopLog
  });
  assert.equal(checked.updateAvailable, true);
  assert.equal(stopped, 0);
  assert.equal(installed, null);

  // Case 3: Upgrade stops host first, then installs exact .tgz URL!
  const upgraded = await runUpgrade({
    paths: { browserHostFile: '/tmp/unused' },
    currentVersion: '0.1.6',
    fetchImpl: mockFetch,
    stopHost: async () => { stopped++; return { stopped: true, pid: 999 }; },
    installPackage: async url => { installed = url; },
    log: noopLog
  });
  assert.equal(upgraded.updated, true);
  assert.equal(stopped, 1);
  assert.equal(installed, 'https://example.test/copi-0.2.0.tgz');
});

test('provider emits live streaming phase and character progress via onStatus without writing scrollback', async () => {
  const statuses = [];
  const provider = createCopilotProvider({
    async ask(prompt, options) {
      const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      await options.onSnapshot({ text: `<<<COPILOT_REPLY_START:${req.requestId}>>>\n\`\`\`json\n{"requestId":"${req.requestId}","type":"final","lines":["` + 'a'.repeat(450) });
      const text = JSON.stringify({ requestId: req.requestId, type: 'final', lines: ['Done.'] });
      return { completed: true, text, codeBlocks: [text] };
    }
  }, { onStatus: msg => statuses.push(msg) });

  const stream = provider.streamSimple(provider.getModels()[0], normalizeContext(base), { sessionId: 'stream-prog' });
  for await (const _ of stream) {}
  await stream.result();
  assert.ok(statuses.some(s => /Sending to Copilot \(think\)/.test(s)));
  assert.ok(statuses.some(s => /Drafting answer \(think, 0\.5K chars\)/.test(s)));
});
