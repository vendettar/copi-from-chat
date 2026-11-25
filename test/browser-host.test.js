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
  return `<!doctype html><html><body>
    <button id="picker" aria-haspopup="menu">GPT-5.6 Sol Think deeper</button>
    <div id="m365-chat-editor-target-element" contenteditable="true" data-lexical-editor="true"></div>
    <button id="send">Send</button>
    <button id="stop" data-testid="stop-button" hidden>Stop</button>
    <main id="replies"></main>
    <script>
      const composer = document.getElementById('m365-chat-editor-target-element');
      const stop = document.getElementById('stop');
      window.tabId = Math.random().toString(36).slice(2);
      window.sent = [];
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
          reply.textContent = 'ECHO:' + text + '|TAB:' + window.tabId + '|COUNT:' + window.sent.length;
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
    route.fulfill({ contentType: 'text/html', body: mockChatHtml() })
  );

  const host = await startBrowserHost({ paths, context, sendConfirmTimeoutMs: 600, sendConfirmPollMs: 40 });
  t.after(() => host.shutdown('test'));

  const clientA = new SharedBrowserClient({ paths, sessionId: 'session-alpha' });
  const clientB = new SharedBrowserClient({ paths, sessionId: 'session-beta' });

  // Run two parallel sessions concurrently against the same shared Browser Host.
  const [replyA1, replyB1] = await Promise.all([
    clientA.ask('Hello from Alpha', { fresh: true }),
    clientB.ask('Hello from Beta', { fresh: true })
  ]);

  assert.match(replyA1.text, /^ECHO:Hello from Alpha\|TAB:([^|]+)\|COUNT:1$/);
  assert.match(replyB1.text, /^ECHO:Hello from Beta\|TAB:([^|]+)\|COUNT:1$/);
  const tabA = replyA1.text.match(/TAB:([^|]+)/)[1];
  const tabB = replyB1.text.match(/TAB:([^|]+)/)[1];
  assert.notEqual(tabA, tabB, 'Parallel sessions must use distinct tabs in the shared window');

  // Save turn anchor for Alpha and detach (simulating CLI exit while Browser Host stays running).
  const anchor = { sessionId: 'session-alpha', requestId: 'req-1', catalog: '[]', history: ['h1'], reply: 'r1' };
  await clientA.saveTurnState('session-alpha', anchor);
  await clientA.close({ closeTab: false });

  // Resuming Alpha in a brand-new SharedBrowserClient reuses its existing tab and retrieves the anchor!
  const resumedA = new SharedBrowserClient({ paths, sessionId: 'session-alpha' });
  const cont = await resumedA.getContinuationState('session-alpha');
  assert.equal(cont.hasContinuation, true);
  assert.deepEqual(cont.lastTurn, anchor);

  const replyA2 = await resumedA.ask('Follow-up in Alpha', { fresh: false, requireContinuation: true });
  assert.match(replyA2.text, new RegExp(`^ECHO:Follow-up in Alpha\\|TAB:${tabA}\\|COUNT:2$`));

  // Beta continues cleanly on its own tab without disturbance.
  const replyB2 = await clientB.ask('Follow-up in Beta', { fresh: false, requireContinuation: true });
  assert.match(replyB2.text, new RegExp(`^ECHO:Follow-up in Beta\\|TAB:${tabB}\\|COUNT:2$`));

  // Shutting down the Browser Host causes requireContinuation to fail with proven pre-Send COPILOT_CONTEXT_LOST.
  await host.shutdown('test');
  await assert.rejects(
    resumedA.ask('After host stopped', { fresh: false, requireContinuation: true }),
    error => error.code === 'COPILOT_CONTEXT_LOST' && error.beforeSend === true && error.retryableInFreshChat === true
  );
});
