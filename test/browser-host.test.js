import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startBrowserHost } from '../src/browser-host.js';
import { SharedBrowserClient } from '../src/browser-client.js';
import { ensureCopiDirs, getCopiPaths } from '../src/paths.js';

let engine;
before(async () => {
  try { engine = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true }); }
  catch (error) {
    if (!/Executable doesn't exist|distribution .* is not found/.test(error.message)) throw error;
  }
});
after(async () => { await engine?.close(); });

function mockChatHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <button id="picker" aria-haspopup="menu">自动</button>
    <div id="menu" role="menu" style="min-width:10px;min-height:10px" hidden>
      <div role="menuitemradio" aria-checked="true" data-i="0">自动</div>
      <div role="menuitemradio" aria-checked="false" data-i="1">快速响应</div>
      <div role="menuitemradio" aria-checked="false" data-i="2">深度思考</div>
    </div>
    <div id="m365-chat-editor-target-element" contenteditable="true" data-lexical-editor="true"></div>
    <button id="send">Send</button>
    <button id="stop" data-testid="stop-button" hidden>Stop</button>
    <main id="replies"></main>
    <script>
      const picker = document.getElementById('picker');
      const menu = document.getElementById('menu');
      const composer = document.getElementById('m365-chat-editor-target-element');
      const stop = document.getElementById('stop');
      window.tabId = Math.random().toString(36).slice(2);
      window.sent = [];
      window.selectedModel = '自动';
      picker.onclick = () => { menu.hidden = !menu.hidden; };
      for (const row of menu.querySelectorAll('[role="menuitemradio"]')) {
        row.onclick = () => {
          for (const r of menu.querySelectorAll('[role="menuitemradio"]')) r.setAttribute('aria-checked', 'false');
          row.setAttribute('aria-checked', 'true');
          window.selectedModel = row.textContent;
          picker.textContent = row.textContent;
          menu.hidden = true;
        };
      }
      document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
      document.getElementById('send').onclick = () => {
        const text = composer.innerText;
        window.sent.push(text);
        composer.textContent = '';
        stop.hidden = false;
        const reply = document.createElement('article');
        reply.setAttribute('data-message-author-role', 'assistant');
        reply.setAttribute('aria-busy', 'true');
        reply.textContent = 'Working...';
        document.getElementById('replies').append(reply);
        setTimeout(() => {
          reply.textContent = 'ECHO:' + text + '|TAB:' + window.tabId + '|MODEL:' + window.selectedModel + '|COUNT:' + window.sent.length;
          reply.setAttribute('aria-busy', 'false');
          stop.hidden = true;
        }, 120);
      };
    </script></body></html>`;
}

test('Browser Host enforces bearer token authentication on loopback HTTP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-host-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));
  const host = await startBrowserHost({ paths, context: null });
  t.after(() => host.shutdown('test'));

  const descriptor = JSON.parse(await readFile(paths.browserHostFile, 'utf8'));
  assert.equal(descriptor.host, '127.0.0.1');
  assert.equal(descriptor.port, host.descriptor.port);

  const unauth = await fetch(`http://127.0.0.1:${descriptor.port}/health`);
  assert.equal(unauth.status, 401);

  const authed = await fetch(`http://127.0.0.1:${descriptor.port}/health`, {
    headers: { authorization: `Bearer ${descriptor.token}` }
  });
  assert.equal(authed.status, 200);
  const data = await authed.json();
  assert.equal(data.ok, true);
});

test('Shared Browser Host isolates parallel sessions into dedicated tabs and reuses tabs on resume', async t => {
  if (!engine) { t.skip('An installed Edge/Chrome browser is required.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'copi-host-tabs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));

  const context = await engine.newContext();
  context.setDefaultTimeout(3000);
  await context.route('https://m365.cloud.microsoft/chat', route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: mockChatHtml() })
  );

  const host = await startBrowserHost({ paths, context, sendConfirmTimeoutMs: 600, sendConfirmPollMs: 40 });
  t.after(() => host.shutdown('test'));

  const clientA = new SharedBrowserClient({ paths, sessionId: 'session-alpha' });
  const clientB = new SharedBrowserClient({ paths, sessionId: 'session-beta' });

  // Pre-warm Alpha ahead of chatting, inspect live models, and switch to quick via Browser Host!
  const warmed = await clientA.warm({ wait: true });
  assert.equal(warmed.ready, true);
  const models = await clientA.listModels();
  assert.equal(models.ready, true);
  assert.deepEqual(models.models.map(m => m.label), ['自动', '快速响应', '深度思考']);
  const switched = await clientA.setModelPreference('quick');
  assert.equal(switched.applied, true);
  assert.equal(switched.result.label, '快速响应');

  // Run two parallel sessions concurrently against the same shared Browser Host.
  const [replyA1, replyB1] = await Promise.all([
    clientA.ask('Hello from Alpha', { fresh: true }),
    clientB.ask('Hello from Beta', { fresh: true })
  ]);

  assert.match(replyA1.text, /^ECHO:Hello from Alpha\|TAB:([^|]+)\|MODEL:快速响应\|COUNT:1$/);
  assert.match(replyB1.text, /^ECHO:Hello from Beta\|TAB:([^|]+)\|MODEL:深度思考\|COUNT:1$/);
  const tabA = replyA1.text.match(/TAB:([^|]+)/)[1];
  const tabB = replyB1.text.match(/TAB:([^|]+)/)[1];
  assert.notEqual(tabA, tabB, 'Parallel sessions must use distinct tabs in the shared window');

  // Save turn anchor for Alpha and detach (simulating CLI exit while Browser Host stays running).
  const anchor = { sessionId: 'session-alpha', requestId: 'req-1', catalog: '[]', history: ['h1'], reply: 'r1' };
  await clientA.saveTurnState('session-alpha', anchor);
  await clientA.close({ closeTab: false });

  // Resuming Alpha in a brand-new SharedBrowserClient reuses its existing tab and retrieves the anchor!
  const resumedA = new SharedBrowserClient({ paths, sessionId: 'session-alpha', modelPreference: 'quick' });
  const cont = await resumedA.getContinuationState('session-alpha');
  assert.equal(cont.hasContinuation, true);
  assert.deepEqual(cont.lastTurn, anchor);

  const replyA2 = await resumedA.ask('Follow-up in Alpha', { fresh: false, requireContinuation: true });
  assert.match(replyA2.text, new RegExp(`^ECHO:Follow-up in Alpha\\|TAB:${tabA}\\|MODEL:快速响应\\|COUNT:2$`));

  // Beta continues cleanly on its own tab without disturbance.
  const replyB2 = await clientB.ask('Follow-up in Beta', { fresh: false, requireContinuation: true });
  assert.match(replyB2.text, new RegExp(`^ECHO:Follow-up in Beta\\|TAB:${tabB}\\|MODEL:深度思考\\|COUNT:2$`));

  // Shutting down the Browser Host causes requireContinuation to fail with proven pre-Send COPILOT_CONTEXT_LOST.
  await host.shutdown('test');
  await assert.rejects(
    resumedA.ask('After host stopped', { fresh: false, requireContinuation: true }),
    error => error.code === 'COPILOT_CONTEXT_LOST' && error.beforeSend === true && error.retryableInFreshChat === true
  );
});

test('detaching an empty startup session for /resume reuses the signed-in tab without closing Edge or reloading, and /reconnect keeps Edge alive', async t => {
  if (!engine) { t.skip('An installed Edge/Chrome browser is required.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'copi-host-standby-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));

  const context = await engine.newContext();
  context.setDefaultTimeout(3000);
  let pageLoads = 0;
  await context.route('https://m365.cloud.microsoft/chat', route => {
    pageLoads++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: mockChatHtml() });
  });

  const host = await startBrowserHost({ paths, context, sendConfirmTimeoutMs: 600, sendConfirmPollMs: 40 });
  t.after(() => host.shutdown('test'));

  // 1. Startup empty session S1 warms Edge (single tab) and user signs in.
  const startupSession = new SharedBrowserClient({ paths, sessionId: 'empty-startup' });
  const warm1 = await startupSession.warm({ wait: true });
  assert.equal(warm1.ready, true);
  assert.equal(pageLoads, 1);
  assert.equal(context.pages().filter(p => !p.isClosed()).length, 1);
  const initialTabId = await context.pages()[0].evaluate(() => window.tabId);

  // 2. User runs /resume -> S1 shuts down empty with closeTab: true.
  // Edge must NOT close its sole tab!
  await startupSession.close({ closeTab: true });
  assert.equal(context.pages().filter(p => !p.isClosed()).length, 1);

  // 3. Resumed session S2 warms & sends -> adopts S1's already signed-in tab with ZERO page reload!
  const resumedSession = new SharedBrowserClient({ paths, sessionId: 'resumed-session' });
  const warm2 = await resumedSession.warm({ wait: true });
  assert.equal(warm2.ready, true);
  assert.equal(pageLoads, 1, 'Resumed session should reuse the clean signed-in standby tab without reloading');

  const reply1 = await resumedSession.ask('Continue resumed work', { fresh: true });
  assert.match(reply1.text, new RegExp(`TAB:${initialTabId}\\|`));
  assert.equal(pageLoads, 1);

  // 4. User runs /reconnect while S2 is the ONLY tab in Edge -> must open replacement BEFORE closing old tab!
  let droppedToZero = false;
  const pageCountObserver = () => {
    if (context.pages().filter(p => !p.isClosed()).length === 0) droppedToZero = true;
  };
  for (const p of context.pages()) p.once('close', pageCountObserver);
  await resumedSession.resetTab({ warm: true });
  assert.equal(droppedToZero, false, '/reconnect must never drop Edge to 0 open tabs');
  assert.equal(context.pages().filter(p => !p.isClosed()).length, 1);
  assert.equal(pageLoads, 2);
});
