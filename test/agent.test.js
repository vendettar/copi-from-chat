import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createModelController, createRuntime, resolveSessionManager } from '../src/runtime.js';
import { ensureCopiDirs, getCopiPaths } from '../src/paths.js';
import { readConfig } from '../src/storage.js';

process.env.PI_OFFLINE = '1';
const packet = (request, value) => {
  const text = JSON.stringify({ requestId: request.requestId, ...value });
  return { completed: true, text, codeBlocks: [text] };
};
const final = (request, text = 'Done.') => packet(request, { type: 'final', text });
const call = (request, name, args) => packet(request, { type: 'tool_calls', calls: [{ name, arguments: args }] });

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'copilot-cli-test-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent');
  await mkdir(cwd);
  const browsers = [];
  const factory = options => {
    const browser = {
      calls: [], closes: 0, history: [], context: null,
      async ask(prompt, options) {
        const request = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
        this.calls.push({ request, fresh: options.fresh, length: prompt.length });
        // Emulate the webpage retaining earlier messages, including its own assistant replies.
        if (request.mode === 'bootstrap') {
          this.context = request;
          this.history = [...request.messages];
        } else if (request.mode === 'continue') {
          assert.equal(options.fresh, false);
          assert.equal(options.requireContinuation, true);
          assert.equal(request.sessionId, this.context.sessionId);
          assert.equal(request.systemPrompt, undefined);
          assert.equal(request.tools, undefined);
          this.history.push(...request.messages);
        }
        const reply = await respond({ ...this.context, ...request, messages: this.history }, options);
        const value = JSON.parse(reply.codeBlocks[0]);
        this.history.push({ role: 'assistant', content: value.type === 'final'
          ? [{ type: 'text', text: value.text }]
          : value.calls.map((call, index) => ({ type: 'toolCall', id: `${value.requestId}_${index}`, ...call })) });
        return reply;
      },
      async close() { this.closes++; }
    };
    browsers.push(browser);
    return createRuntime({ ...options, browser });
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd, agentDir, sessionManager: SessionManager.inMemory(cwd)
  });
  runtime.setRebindSession(session => session.bindExtensions({}));
  await runtime.session.bindExtensions({});
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, runtime, browsers };
}

test('Pi runs write, edit, Git Bash and read in the selected project, then continues the same chat', async t => {
  const operations = [
    ['write', { path: 'note.txt', content: 'before\n' }],
    ['edit', { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] }],
    ['bash', { command: 'cat note.txt' }],
    ['read', { path: 'note.txt', limit: 5 }]
  ];
  const { cwd, runtime, browsers } = await fixture(t, request => {
    const results = request.messages.filter(message => message.role === 'toolResult');
    assert.ok(results.every(result => !result.isError));
    const operation = operations[results.length];
    return operation ? call(request, ...operation) : final(request);
  });
  await runtime.session.prompt('Create and verify note.txt.');
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'after\n');
  assert.equal(runtime.session.getLastAssistantText(), 'Done.');
  const replies = browsers[0].history.filter(m => m.role === 'toolResult');
  assert.match(replies[2].content[0].text, /after/);
  assert.match(replies[3].content[0].text, /after/);
  await runtime.session.prompt('Continue from those results.');
  assert.deepEqual(browsers[0].calls.map(call => call.fresh), [true, false, false, false, false, false]);
  assert.equal(browsers[0].history.filter(m => m.role === 'user').length, 2);
  assert.equal(browsers[0].calls.at(-1).request.messages.length, 1);
  assert.deepEqual(browsers[0].calls.slice(1, 5).map(call => call.request.messages.map(m => m.role)),
    [['toolResult'], ['toolResult'], ['toolResult'], ['toolResult']]);
});

test('large read results use a saved preview; the next user turn sends only new text', async t => {
  const { cwd, runtime, browsers } = await fixture(t, request => request.messages.some(m => m.role === 'toolResult')
    ? final(request, 'File inspected.') : call(request, 'read', { path: 'large.txt', limit: 200 }));
  await writeFile(join(cwd, 'large.txt'), ('x'.repeat(199) + '\n').repeat(100));
  await runtime.session.prompt('Read large.txt.');
  assert.equal(runtime.session.getLastAssistantText(), 'File inspected.');
  const preview = browsers[0].history.find(message => message.role === 'toolResult').content[0].text;
  const path = preview.match(/\nSaved tool result: (.+)\n/)[1];
  t.after(() => rm(path, { force: true }));
  const original = runtime.session.messages.find(message => message.role === 'toolResult').content[0].text;
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(preview.length < original.length);
  await runtime.session.prompt('Continue using what you just read.');
  assert.equal(runtime.session.getLastAssistantText(), 'File inspected.');
  const browser = browsers[0];
  assert.ok(original.length > 18000);
  assert.ok(JSON.stringify([{ type: 'text', text: preview }]).length <= 5000);
  assert.deepEqual(browser.calls.map(call => call.request.mode), ['bootstrap', 'continue', 'continue']);
  assert.ok(browser.calls.at(-1).length < 4000);
  assert.equal(browser.calls.at(-1).request.messages.length, 1);
  assert.equal(browser.calls.at(-1).request.messages[0].role, 'user');
});

test('Pi can read omitted command output from its saved result without executing the command again', async t => {
  let savedPath;
  const { cwd, runtime, browsers } = await fixture(t, request => {
    const results = request.messages.filter(message => message.role === 'toolResult');
    if (!results.length) return call(request, 'bash', { command: 'node output.cjs' });
    if (results.length === 1) {
      const result = results[0];
      savedPath = result.content[0].text.match(/\nSaved tool result: (.+)\n/)[1];
      t.after(() => rm(savedPath, { force: true }));
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Command exited with code 1/);
      return call(request, 'read', { path: savedPath, offset: 100, limit: 2 });
    }
    assert.equal(results[1].isError, false);
    assert.match(results[1].content[0].text, /ROW_100[\s\S]*ROW_101/);
    return final(request, 'Output inspected.');
  });
  // Below Pi's native 50 KiB cap, but quotes/backslashes almost double the JSON sent to the webpage.
  const output = Array.from({ length: 200 }, (_, i) => `ROW_${String(i + 1).padStart(3, '0')} ` + '"\\'.repeat(118)).join('\n') + '\n';
  await writeFile(join(cwd, 'output.cjs'),
    `require('node:fs').appendFileSync('runs.txt', 'run\\n');\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exitCode = 1;\n`);
  await runtime.session.prompt('Run output.cjs once and inspect the result near line 100.');
  assert.equal(runtime.session.getLastAssistantText(), 'Output inspected.');
  const original = runtime.session.messages.find(message => message.role === 'toolResult');
  assert.ok(JSON.stringify(original.content).length > 96000);
  assert.equal(await readFile(savedPath, 'utf8'), original.content[0].text);
  assert.ok(browsers[0].calls[1].length < 24000);
  await runtime.session.prompt('Continue from the inspected result.');
  assert.equal(runtime.session.getLastAssistantText(), 'Output inspected.');
  assert.equal(await readFile(join(cwd, 'runs.txt'), 'utf8'), 'run\n');
  assert.deepEqual(browsers[0].calls.map(call => call.request.mode), ['bootstrap', 'continue', 'continue', 'continue']);
  assert.deepEqual(browsers[0].calls.at(-1).request.messages.map(message => message.role), ['user']);
});

test('Pi searches ignored-aware project files through generic tools, then reads the matching source', async t => {
  const { cwd, runtime, browsers } = await fixture(t, request => {
    const results = request.messages.filter(message => message.role === 'toolResult');
    const operations = [
      ['find', { pattern: '*.js' }],
      ['grep', { pattern: 'PROJECT_NEEDLE', path: '.', glob: '*.js' }],
      ['read', { path: 'src/main.js', offset: 1, limit: 5 }]
    ];
    assert.ok(results.every(result => !result.isError), JSON.stringify(results));
    const advertised = request.tools.filter(tool => ['find', 'grep'].includes(tool.name));
    assert.equal(advertised.length, 2);
    assert.doesNotMatch(JSON.stringify(advertised), /\b(?:git|rg|fd)\b|8000|JSON budget/i);
    assert.doesNotMatch(request.systemPrompt, /Use bash for file operations like ls, rg, find/);
    return operations[results.length] ? call(request, ...operations[results.length]) : final(request, 'Found the source.');
  });
  await promisify(execFile)('git', ['init', '-q'], { cwd });
  for (const dir of ['src', 'build', '.idea/patches']) await mkdir(join(cwd, dir), { recursive: true });
  await writeFile(join(cwd, '.gitignore'), 'build/\n.idea/\n');
  for (const path of ['src/main.js', 'build/generated.js', '.idea/patches/old.js']) {
    await writeFile(join(cwd, path), 'const name = "PROJECT_NEEDLE";\n');
  }
  await runtime.session.prompt('Find PROJECT_NEEDLE in source files and inspect the surrounding code.');
  assert.equal(runtime.session.getLastAssistantText(), 'Found the source.');
  const results = browsers[0].history.filter(message => message.role === 'toolResult');
  assert.equal(results[0].content[0].text, 'src/main.js');
  assert.match(results[1].content[0].text, /src\/main\.js:1:/);
  assert.match(results[2].content[0].text, /PROJECT_NEEDLE/);
  assert.deepEqual(browsers[0].calls.map(call => call.request.mode), ['bootstrap', 'continue', 'continue', 'continue']);
});

test('search failures reach the model as tool-contract errors without leaking the execution backend', async t => {
  const { runtime, browsers } = await fixture(t, request => request.messages.some(message => message.role === 'toolResult')
    ? final(request, 'Select a project directory.') : call(request, 'find', { pattern: '*.js' }));
  await runtime.session.prompt('Find JavaScript files.');
  const result = browsers[0].history.find(message => message.role === 'toolResult');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /version-controlled project/);
  assert.doesNotMatch(result.content[0].text, /\bgit\b|ls-files|execFile|stderr/i);
  assert.equal(runtime.session.getLastAssistantText(), 'Select a project directory.');
});

test('/new closes the old browser and starts an independent session without persisting history', async t => {
  const { cwd, runtime, browsers } = await fixture(t, request => final(request));
  await runtime.session.prompt('Remember project one.');
  assert.equal(runtime.session.sessionManager.isPersisted(), false);
  assert.equal(runtime.session.sessionFile, undefined);
  await runtime.newSession();
  assert.equal(browsers[0].closes, 1);
  assert.equal(runtime.session.messages.filter(m => m.role === 'user').length, 0);
  await runtime.session.prompt('A different task.');
  assert.equal(runtime.cwd, cwd);
  const request = browsers[1].calls[0];
  assert.equal(request.fresh, true);
  assert.deepEqual(request.request.messages.filter(m => m.role === 'user').map(m => m.content[0].text),
    ['A different task.']);
  assert.equal(runtime.session.sessionManager.isPersisted(), false);
  assert.equal(runtime.session.sessionFile, undefined);
});

test('abort never replays the interrupted conversation; /new starts a clean task', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let count = 0;
  const { runtime, browsers } = await fixture(t, async (request, { signal }) => {
    if (++count === 2) {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
    }
    return final(request);
  });
  await runtime.session.prompt('First task.');
  const pending = runtime.session.prompt('Slow task.');
  await started;
  await runtime.session.abort();
  await pending;
  assert.equal(count, 2);
  await runtime.session.prompt('A new instruction after stopping.');
  assert.match(runtime.session.messages.at(-1).errorMessage, /Use \/new/);
  assert.deepEqual(browsers[0].calls.map(call => call.fresh), [true, false]);
  await runtime.newSession();
  await runtime.session.prompt('A clean task.');
  assert.equal(runtime.session.getLastAssistantText(), 'Done.');
  assert.equal(browsers[1].calls.length, 1);
  assert.deepEqual(browsers[1].calls[0].request.messages.map(m => m.content[0].text), ['A clean task.']);
});

test('persisted sessions save JSONL under ~/.copi/sessions, resume with proactive compaction, and keep transcript unmodified', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-resume-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const copiHome = join(root, 'copi-home');
  await mkdir(cwd);
  const copiPaths = await ensureCopiDirs(getCopiPaths(copiHome));
  const sessionDir = join(copiPaths.sessionsDir, 'test-project');

  const browsers = [];
  const makeBrowser = () => {
    const browser = {
      calls: [], closes: 0,
      async ask(prompt, options) {
        const request = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
        this.calls.push({ request, fresh: options.fresh });
        const lastMsg = request.messages.at(-1);
        const lastText = typeof lastMsg?.content === 'string'
          ? lastMsg.content
          : lastMsg?.content?.map(b => b.text ?? '').join('') ?? '';
        if (lastMsg?.role === 'user' && lastText.includes('Write checkpoint file')) {
          return call(request, 'write', { path: 'checked.txt', content: 'ok\n' });
        }
        return final(request, `Reply ${this.calls.length}.`);
      },
      async close() { this.closes++; }
    };
    browsers.push(browser);
    return browser;
  };

  // Start a persisted session and build >12 messages so resume triggers proactive compaction.
  const initialManager = SessionManager.create(cwd, sessionDir);
  const runtime1 = await createAgentSessionRuntime(
    options => createRuntime({ ...options, browser: makeBrowser(), copiPaths }),
    { cwd, agentDir: copiHome, sessionManager: initialManager }
  );
  runtime1.setRebindSession(session => session.bindExtensions({}));
  await runtime1.session.bindExtensions({});

  await runtime1.session.prompt('Write checkpoint file.');
  for (let i = 1; i <= 6; i++) {
    await runtime1.session.prompt(`Follow-up turn ${i} that must stay verbatim.`);
  }
  const sessionId = runtime1.session.sessionManager.getSessionId();
  const sessionFile = runtime1.session.sessionFile;
  assert.ok(sessionFile);
  assert.ok(runtime1.session.messages.length > 12);
  const transcriptBeforeResume = await readFile(sessionFile, 'utf8');

  // While runtime1 holds the session lock, a second runtime attempting the same sessionId must be rejected.
  const duplicateManager = SessionManager.open(sessionFile, sessionDir);
  await assert.rejects(
    createRuntime({ cwd, agentDir: copiHome, sessionManager: duplicateManager, browser: makeBrowser(), copiPaths }),
    { code: 'COPI_LOCKED' }
  );

  await runtime1.dispose();

  // Verify checkpoints and activity log were written.
  const checkpointFile = join(copiPaths.checkpointsDir, `${sessionId}.jsonl`);
  const checkpoints = (await readFile(checkpointFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(checkpoints.some(c => c.toolName === 'write' && c.phase === 'started'));
  assert.ok(checkpoints.some(c => c.toolName === 'write' && c.phase === 'completed'));
  const activity = (await readFile(copiPaths.activityLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(activity.some(a => a.event === 'session_start'));
  assert.ok(activity.some(a => a.event === 'session_end'));

  // Resume via resolveSessionManager (--continue and --session prefix).
  const byContinue = await resolveSessionManager({ cwd, continueRecent: true, sessionDir });
  assert.equal(byContinue.resumed, true);
  assert.equal(byContinue.sessionManager.getSessionId(), sessionId);

  const byPrefix = await resolveSessionManager({ cwd, sessionId: sessionId.slice(0, 8), sessionDir });
  assert.equal(byPrefix.resumed, true);
  assert.equal(byPrefix.sessionManager.getSessionId(), sessionId);

  const resumedBrowser = makeBrowser();
  const runtime2 = await createAgentSessionRuntime(
    options => createRuntime({ ...options, browser: resumedBrowser, copiPaths }),
    { cwd, agentDir: copiHome, sessionManager: byPrefix.sessionManager }
  );
  runtime2.setRebindSession(session => session.bindExtensions({}));
  await runtime2.session.bindExtensions({});
  t.after(() => runtime2.dispose());

  await runtime2.session.prompt('Continue after resume.');
  assert.equal(resumedBrowser.calls.length, 1);
  assert.equal(resumedBrowser.calls[0].fresh, true);
  assert.equal(resumedBrowser.calls[0].request.mode, 'bootstrap');
  assert.equal(resumedBrowser.calls[0].request.resumed, true);
  assert.equal(resumedBrowser.calls[0].request.compacted, true);
  assert.ok(resumedBrowser.calls[0].request.messages.length < runtime2.session.messages.length);

  // Saved JSONL transcript only appended the new turn; all earlier lines remain unmodified!
  const transcriptAfterResume = await readFile(sessionFile, 'utf8');
  assert.ok(transcriptAfterResume.startsWith(transcriptBeforeResume));

  // Verify interactive /resume (runtime.switchSession) switches to another saved session and releases/reacquires locks.
  const secondManager = SessionManager.create(cwd, sessionDir);
  const runtime3 = await createAgentSessionRuntime(
    options => createRuntime({ ...options, browser: makeBrowser(), copiPaths }),
    { cwd, agentDir: copiHome, sessionManager: secondManager }
  );
  runtime3.setRebindSession(session => session.bindExtensions({}));
  await runtime3.session.bindExtensions({});
  t.after(() => runtime3.dispose());
  await runtime3.session.prompt('Second session prompt.');
  const secondSessionFile = runtime3.session.sessionFile;
  assert.ok(secondSessionFile);

  // Switching runtime2 to secondSessionFile while runtime3 holds its lock is cancelled cleanly.
  const cancelledSwitch = await runtime2.switchSession(secondSessionFile);
  assert.equal(cancelledSwitch.cancelled, true);

  // After runtime3 disposes, runtime2 can switchSession cleanly.
  await runtime3.dispose();
  const okSwitch = await runtime2.switchSession(secondSessionFile);
  assert.equal(okSwitch.cancelled, false);
  assert.equal(runtime2.session.sessionFile, secondSessionFile);
});

test('copi CLI --help, --version, doctor, host status, and sessions subcommands work', async () => {
  const exec = promisify(execFile);
  const { stdout: helpOut } = await exec(process.execPath, ['src/agent.js', '--help']);
  assert.match(helpOut, /Usage:/);
  assert.match(helpOut, /copi doctor/);
  assert.match(helpOut, /copi host <status\|stop>/);
  assert.match(helpOut, /copi sessions/);
  assert.match(helpOut, /--continue/);
  assert.match(helpOut, /--session <id>/);
  assert.match(helpOut, /--model <target>/);
  assert.match(helpOut, /--readonly/);
  assert.match(helpOut, /--yes/);
  assert.match(helpOut, /--no-bell/);
  assert.match(helpOut, /--profile <name>/);
  assert.match(helpOut, /\/think/);
  assert.match(helpOut, /\/quota/);
  assert.match(helpOut, /\/undo/);
  assert.match(helpOut, /\/export/);

  const { stdout: versionOut } = await exec(process.execPath, ['src/agent.js', '--version']);
  assert.equal(versionOut.trim(), '0.1.0');

  const tmpHome = await mkdtemp(join(tmpdir(), 'copi-cli-subcmd-'));
  try {
    const env = { ...process.env, COPI_HOME: tmpHome };
    const { stdout: hostOut } = await exec(process.execPath, ['src/agent.js', 'host', 'status'], { env });
    assert.match(hostOut, /Browser Host is not running/);
    const { stdout: docOut } = await exec(process.execPath, ['src/agent.js', 'doctor'], { env });
    assert.match(docOut, /\[PASS\] Node\.js/);
    assert.match(docOut, /Daily turns/);
    const { stdout: sessOut } = await exec(process.execPath, ['src/agent.js', 'sessions'], { env });
    assert.match(sessOut, /No saved sessions found/);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test('interactive startup pre-warms Edge and modelController persists and applies preferences', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-model-ctrl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const copiHome = join(root, 'copi-home');
  await mkdir(cwd);
  const copiPaths = await ensureCopiDirs(getCopiPaths(copiHome));

  let warmed = 0;
  const switched = [];
  const mockBrowser = {
    async warm() { warmed++; return { ready: true }; },
    async listModels() {
      return {
        ready: true,
        current: '自动',
        models: [
          { index: 0, label: '自动', description: '', selected: true },
          { index: 1, label: '快速响应', description: '', selected: false },
          { index: 2, label: '深度思考', description: '', selected: false }
        ]
      };
    },
    async setModelPreference(pref) {
      switched.push(pref);
      return { preference: pref, applied: true, result: { index: 1, label: '快速响应' } };
    },
    async ask(prompt) {
      const request = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      return final(request, 'OK.');
    },
    async close() {}
  };

  const controller = createModelController({ copiPaths });
  const runtime = await createAgentSessionRuntime(
    options => createRuntime({
      ...options,
      browser: mockBrowser,
      copiPaths,
      modelController: controller,
      prewarmBrowser: true
    }),
    { cwd, agentDir: copiHome, sessionManager: SessionManager.inMemory(cwd) }
  );
  t.after(() => runtime.dispose());

  assert.equal(warmed, 1, 'Expected prewarmBrowser to launch Edge immediately on startup');
  const listed = await controller.listModels();
  assert.equal(listed.models.length, 3);
  const res = await controller.setPreference('quick');
  assert.equal(res.applied, true);
  assert.deepEqual(switched, [{ kind: 'preset', name: 'quick' }]);
  assert.deepEqual(await readConfig(copiPaths), { modelPreference: 'quick' });
});
