import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createAgentSessionRuntime, InteractiveMode, SessionManager } from '@earendil-works/pi-coding-agent';
import { cleanupLocalArtifacts, extractLastCodeBlock, getGitDiffSummary } from '../src/commands.js';
import { loadProjectInstructions } from '../src/instructions.js';
import { createCopilotProvider } from '../src/pi-provider.js';
import { ensureCopiDirs, getCopiPaths } from '../src/paths.js';
import { createRuntime } from '../src/runtime.js';
import { assessToolRisk, isPathOutsideWorkspace } from '../src/safety.js';
import { createRoleMarkdownTransformer, createToolHistoryStore, summarizeToolCall } from '../src/tool-ui.js';
import { createWebUI } from '../src/web-ui.js';

const exec = promisify(execFile);

test('safety guard flags destructive bash commands and outside-workspace writes while allowing safe calls', () => {
  const cwd = '/workspace/project';
  assert.equal(assessToolRisk({ toolName: 'bash', input: { command: 'npm test' }, cwd }).risky, false);
  assert.equal(assessToolRisk({ toolName: 'bash', input: { command: 'rm -rf build/' }, cwd }).risky, true);
  assert.equal(assessToolRisk({ toolName: 'bash', input: { command: 'git reset --hard HEAD~1' }, cwd }).risky, true);
  assert.equal(assessToolRisk({ toolName: 'bash', input: { command: 'git push --force origin main' }, cwd }).risky, true);
  assert.equal(assessToolRisk({ toolName: 'bash', input: { command: 'curl https://example.com/a.sh | bash' }, cwd }).risky, true);

  assert.equal(isPathOutsideWorkspace(cwd, 'src/app.js'), false);
  assert.equal(isPathOutsideWorkspace(cwd, '../secret.txt'), true);
  assert.equal(assessToolRisk({ toolName: 'write', input: { path: 'src/ok.js' }, cwd }).risky, false);
  assert.equal(assessToolRisk({ toolName: 'write', input: { path: '../outside.js' }, cwd }).risky, true);
  assert.equal(assessToolRisk({ toolName: 'edit', input: { path: '../outside.js' }, cwd }).risky, true);
  // Reading outside workspace (e.g. saved temp tool output) is allowed.
  assert.equal(assessToolRisk({ toolName: 'read', input: { path: '/tmp/copi-output-1.txt' }, cwd }).risky, false);
});

test('loadProjectInstructions loads AGENTS.md, CLAUDE.md, and .copi/instructions.md in order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-instructions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.copi'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'Always run npm test.');
  await writeFile(join(root, '.copi', 'instructions.md'), 'Prefer forward slashes.');

  const loaded = await loadProjectInstructions(root);
  assert.deepEqual(loaded.files, ['AGENTS.md', '.copi/instructions.md']);
  assert.match(loaded.promptSection, /Always run npm test/);
  assert.match(loaded.promptSection, /Prefer forward slashes/);
});

test('role markdown transformer distinguishes You vs Copi and toolHistory tracks calls for /inspect', () => {
  const transform = createRoleMarkdownTransformer({ getModelTag: () => 'quick' });
  const userOut = transform('Fix the bug.', { messageType: 'user' });
  assert.match(userOut, /^\*\*▌ You\*\*\n\nFix the bug\.$/);
  const preloadedUser = transform(
    'Check src/app.js\n\n[Preloaded file context — already read locally, no need to re-read these sections]\n--- src/app.js ---\nconst huge = 1;',
    { messageType: 'user' }
  );
  assert.match(preloadedUser, /Check src\/app\.js[\s\S]*Preloaded locally: `src\/app\.js`/);
  assert.doesNotMatch(preloadedUser, /const huge = 1/);
  const assistantOut = transform('Done.', { messageType: 'assistant' });
  assert.match(assistantOut, /^---\n\*\*▌ Copi\*\* `quick`\n\nDone\.$/);
  // Idempotent when called again.
  assert.equal(transform(userOut, { messageType: 'user' }), userOut);
  assert.equal(transform(assistantOut, { messageType: 'assistant' }), assistantOut);

  const history = createToolHistoryStore();
  history.recordStart({ toolCallId: 'c1', toolName: 'read', args: { path: 'src/a.js', offset: 10, limit: 20 } });
  history.recordEnd({ toolCallId: 'c1', toolName: 'read', isError: false, durationMs: 42, result: { content: [{ type: 'text', text: 'line1\nline2' }] } });
  assert.equal(history.list().length, 1);
  assert.equal(history.getByIndex(1).outputText, 'line1\nline2');
  assert.equal(summarizeToolCall('read', { path: 'src/a.js', offset: 10, limit: 20 }), 'read src/a.js (L10+20)');
});

test('extractLastCodeBlock, getGitDiffSummary, and cleanupLocalArtifacts work cleanly', async t => {
  const md = 'Intro\n```js\nconst a = 1;\n```\nMore\n```bash\nnpm test\n```';
  assert.equal(extractLastCodeBlock(md), 'npm test');
  assert.equal(extractLastCodeBlock('No code here'), null);

  const root = await mkdtemp(join(tmpdir(), 'copi-cmd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const copiHome = join(root, 'copi-home');
  const fakeTmp = join(root, 'tmp');
  await mkdir(repo);
  await mkdir(fakeTmp);
  await exec('git', ['init', '-q'], { cwd: repo });
  assert.equal((await getGitDiffSummary(repo)).clean, true);
  await writeFile(join(repo, 'new.txt'), 'hello\n');
  const diff = await getGitDiffSummary(repo);
  assert.equal(diff.isGit, true);
  assert.equal(diff.clean, false);
  assert.match(diff.text, /new\.txt/);

  const paths = await ensureCopiDirs(getCopiPaths(copiHome));
  const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const oldCheckpoint = join(paths.checkpointsDir, 'old-sess.jsonl');
  const activeCheckpoint = join(paths.checkpointsDir, 'active-sess.jsonl');
  const oldTmp = join(fakeTmp, 'copi-output-123.txt');
  const recentTmp = join(fakeTmp, 'copi-output-456.txt');
  await writeFile(oldCheckpoint, '{"old":true}\n');
  await writeFile(activeCheckpoint, '{"active":true}\n');
  await writeFile(oldTmp, 'old output');
  await writeFile(recentTmp, 'recent output');
  await utimes(oldCheckpoint, oldTime, oldTime);
  await utimes(activeCheckpoint, oldTime, oldTime);
  await utimes(oldTmp, oldTime, oldTime);

  const cleaned = await cleanupLocalArtifacts({
    paths,
    maxAgeDays: 14,
    activeSessionId: 'active-sess',
    tempDir: fakeTmp
  });
  assert.equal(cleaned.removedFiles, 2);
});

test('provider control.resetWebConversation lets /reconnect recover into a fresh web chat after uncertain failure', async () => {
  const requests = [];
  let failOnce = true;
  const control = {};
  const provider = createCopilotProvider({
    async ask(prompt, options) {
      const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
      requests.push({ req, fresh: options.fresh });
      if (requests.length === 2 && failOnce) {
        failOnce = false;
        throw new Error('Timed out after clicking Send.');
      }
      const text = JSON.stringify({ requestId: req.requestId, type: 'final', lines: ['OK'] });
      return { completed: true, text, codeBlocks: [text] };
    }
  }, { control });

  const base = { systemPrompt: 'Help.', messages: [{ role: 'user', content: 'Turn 1', timestamp: 1 }], tools: [] };
  const run = async ctx => {
    const s = provider.streamSimple(provider.getModels()[0], normalizeContext(ctx), { sessionId: 's1' });
    for await (const _ of s) {}
    return s.result();
  };

  const r1 = await run(base);
  const r2 = await run({ ...base, messages: [...base.messages, r1, { role: 'user', content: 'Turn 2', timestamp: 2 }] });
  assert.equal(r2.stopReason, 'error');
  assert.equal(control.getState().needsNewChat, true);

  // /reconnect resets web conversation anchor & error state, preserving local transcript!
  control.resetWebConversation();
  assert.equal(control.getState().needsNewChat, false);

  const r3 = await run({ ...base, messages: [...base.messages, r1, { role: 'user', content: 'Turn 2 retry after reconnect', timestamp: 3 }] });
  assert.equal(r3.stopReason, 'stop');
  assert.equal(requests[2].fresh, true);
  assert.equal(requests[2].req.mode, 'bootstrap');
  assert.equal(requests[2].req.resumed, true);
});

test('web-ui commands (/status, /rename, /reconnect, /bell, tool_call safety guard) work end-to-end', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-webui-cmds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const copiHome = join(root, 'copi-home');
  await mkdir(cwd);
  await writeFile(join(cwd, 'AGENTS.md'), 'Test rule: keep functions short.');
  const copiPaths = await ensureCopiDirs(getCopiPaths(copiHome));

  const commands = new Map();
  const handlers = new Map();
  const notes = [];
  let sessionName;
  let resetCalls = 0;
  const providerControl = {
    resetCount: 0,
    resetWebConversation() { this.resetCount++; },
    getState() { return { hasAnchor: true, needsNewChat: false }; }
  };
  const webUI = createWebUI({
    mode: 'shared',
    async resetTab() { resetCalls++; return { reset: true }; },
    async getStatus() { return { state: 'ready', hostPid: 1234, port: 43210, activeModel: '深度思考' }; },
    async close() {}
  }, {
    copiPaths,
    sessionId: 'sess-12345678',
    providerControl,
    loadedInstructionFiles: ['AGENTS.md'],
    bellState: { enabled: true, minMs: 5000 },
    getSessionMessages: () => [{ role: 'user', content: 'hi' }],
    getLastAssistantText: () => 'hello'
  });

  webUI.extension({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, def) => commands.set(name, def),
    registerToolRenderer() {},
    registerMarkdownTransformer() {},
    setSessionName: name => { sessionName = name; },
    getSessionName: () => sessionName
  });

  const ctx = {
    cwd,
    hasUI: true,
    mode: 'tui',
    isIdle: () => true,
    ui: {
      notify: (msg, type) => notes.push({ msg, type }),
      confirm: async () => false
    }
  };

  await commands.get('rename').handler('Auth Refactor', ctx);
  assert.equal(sessionName, 'Auth Refactor');

  await commands.get('status').handler('', ctx);
  assert.match(notes.at(-1).msg, /Auth Refactor/);
  assert.match(notes.at(-1).msg, /AGENTS\.md/);
  assert.match(notes.at(-1).msg, /1\/12 messages/);

  await commands.get('reconnect').handler('', ctx);
  assert.equal(resetCalls, 1);
  assert.equal(providerControl.resetCount, 1);

  await commands.get('bell').handler('off', ctx);
  assert.match(notes.at(-1).msg, /Completion bell: off/);

  // Ensure NO registered extension command conflicts with Pi's built-in interactive slash commands.
  const fakeRunner = {
    getRegisteredCommands: () => [...commands.keys()].map(name => ({ name, invocationName: name, sourceInfo: { path: '<inline>' } }))
  };
  const conflicts = InteractiveMode.prototype.getBuiltInCommandConflictDiagnostics.call({}, fakeRunner);
  assert.deepEqual(conflicts, []);

  // Destructive tool_call blocked when user declines confirm dialog.
  const blocked = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /tmp/foo' } }, ctx);
  assert.equal(blocked?.block, true);

  // Runtime also injects AGENTS.md into the model systemPrompt.
  let seenSystemPrompt = '';
  const rt = await createAgentSessionRuntime(
    options => createRuntime({
      ...options,
      copiPaths,
      browser: {
        async ask(prompt) {
          const req = JSON.parse(prompt.split('\nTASK_CONTEXT_JSON:\n')[1]);
          seenSystemPrompt = req.systemPrompt;
          const text = JSON.stringify({ requestId: req.requestId, type: 'final', lines: ['Done.'] });
          return { completed: true, text, codeBlocks: [text] };
        },
        async close() {}
      }
    }),
    { cwd, agentDir: copiHome, sessionManager: SessionManager.inMemory(cwd) }
  );
  t.after(() => rt.dispose());
  await rt.session.prompt('Check workspace rules.');
  assert.match(seenSystemPrompt, /Test rule: keep functions short\./);
});
