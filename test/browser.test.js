import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CopilotBrowser } from '../src/browser.js';

let engine;
before(async () => {
  try { engine = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true }); }
  catch (error) {
    if (!/Executable doesn't exist|distribution .* is not found/.test(error.message)) throw error;
    // Use an installed browser only; tests must not download one in the restricted target environment.
  }
});
after(async () => { await engine?.close(); });

async function fixture(t, config = {}) {
  if (!engine) { t.skip('An installed Edge/Chrome browser is required.'); return; }
  const context = await engine.newContext();
  context.setDefaultTimeout(1500);
  const items = config.items ?? [
    { label: 'Auto', desc: 'Decides how long to think' },
    { label: 'Quick response', desc: 'Answers right away' },
    { label: 'Think deeper', desc: 'Think longer for better answers' }
  ];
  const initialIndex = config.initialIndex ?? 0;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    ${config.noPicker ? '' : `<button id="${config.pickerId ?? 'picker'}" aria-haspopup="menu"${config.pickerAriaLabel ? ` aria-label="${config.pickerAriaLabel}"` : ''}>${config.pickerText ?? items[initialIndex]?.label ?? 'Auto'}</button>`}
    <div id="menu" role="menu" style="min-width:10px;min-height:10px" hidden></div>
    <div id="submenu" role="menu" style="min-width:10px;min-height:10px" hidden></div>
    <div id="m365-chat-editor-target-element" contenteditable="true" data-lexical-editor="true"></div>
    <button id="send">Send</button><button id="stop" data-testid="stop-button" hidden>Stop</button>
    <main id="replies"></main>
    <script>
      const config = ${JSON.stringify({ ...config, items, initialIndex })};
      const picker = document.getElementById(config.pickerId ?? 'picker');
      const menu = document.getElementById('menu');
      const submenu = document.getElementById('submenu');
      let composer = document.getElementById('m365-chat-editor-target-element');
      let selectedIndex = config.initialIndex;
      let selectedLabel = config.items[selectedIndex]?.label ?? (picker ? picker.textContent : 'Auto');
      window.actions = [];
      window.sent = [];
      window.inputSelections = [];
      window.sendClicks = 0;

      const updateChecks = () => {
        for (const el of document.querySelectorAll('[data-item-index]')) {
          const idx = Number(el.dataset.itemIndex);
          const active = idx === selectedIndex && !config.submenuItems;
          if (config.checkmark) {
            const mark = el.querySelector('.check');
            if (mark) mark.style.visibility = active ? 'visible' : 'hidden';
          } else {
            el.setAttribute('aria-checked', active ? 'true' : 'false');
          }
        }
      };

      const makeItem = (item, idx, isSub = false) => {
        const row = document.createElement('div');
        row.setAttribute('role', item.submenu ? 'menuitem' : 'menuitemradio');
        row.setAttribute('tabindex', '0');
        row.dataset.itemIndex = String(idx);
        if (item.disabled) row.setAttribute('aria-disabled', 'true');
        if (item.submenu) row.setAttribute('aria-haspopup', 'menu');
        row.innerHTML = '<h4>' + item.label + '</h4>' + (item.desc ? '<p>' + item.desc + '</p>' : '');
        if (config.checkmark && !item.submenu) {
          const mark = document.createElement('span');
          mark.className = 'check';
          mark.style.visibility = 'hidden';
          mark.innerHTML = '<svg data-testid="checkmark-model" width="10" height="10"><path d="M0 5 L5 10 L10 0" /></svg>';
          row.append(mark);
        } else if (!item.submenu) {
          row.setAttribute('aria-checked', (!isSub && idx === selectedIndex) || (isSub && item.selected) ? 'true' : 'false');
        }
        if (item.submenu) {
          const expand = () => { window.actions.push('submenu:' + idx); submenu.hidden = false; };
          row.onclick = expand;
          if (config.hover) row.onpointerenter = () => setTimeout(expand, 80);
        } else {
          row.onclick = () => {
            window.actions.push((isSub ? 'sub:' : 'item:') + idx);
            if (item.ignore || config.ignoreAll) return;
            selectedIndex = idx;
            selectedLabel = item.label;
            if (picker) picker.textContent = item.label;
            if (isSub) {
              for (const s of submenu.querySelectorAll('[role="menuitemradio"]')) s.setAttribute('aria-checked', 'false');
              row.setAttribute('aria-checked', 'true');
            } else {
              updateChecks();
            }
            if (!config.keepMenu) { menu.hidden = true; submenu.hidden = true; }
          };
        }
        return row;
      };

      if (!config.emptyMenu) {
        config.items.forEach((item, idx) => menu.append(makeItem(item, idx, false)));
      }
      if (config.submenuItems) {
        config.submenuItems.forEach((item, idx) => submenu.append(makeItem(item, idx, true)));
      }
      updateChecks();

      if (picker) {
        picker.onclick = () => {
          window.actions.push('picker');
          menu.hidden = !menu.hidden;
          submenu.hidden = true;
        };
      }
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (!submenu.hidden) submenu.hidden = true; else menu.hidden = true;
      });
      const onInput = () => {
        if (!composer.textContent) return;
        window.inputSelections.push(selectedLabel);
        if (!config.rebuildEditor || window.rebuilt) return;
        window.rebuilt = true;
        const replacement = composer.cloneNode(true);
        if (config.roleEditor) {
          replacement.removeAttribute('id');
          replacement.removeAttribute('data-lexical-editor');
          replacement.setAttribute('role', 'textbox');
          replacement.setAttribute('aria-label', 'Message Copilot');
        }
        replacement.oninput = onInput;
        const placeholder = document.createComment('editor remount');
        composer.replaceWith(placeholder);
        setTimeout(() => { placeholder.replaceWith(replacement); composer = replacement; }, config.rebuildDelay ?? 0);
      };
      composer.oninput = onInput;
      document.getElementById('send').onclick = () => {
        window.sendClicks++;
        if (config.ignoreSendCount && window.sendClicks <= config.ignoreSendCount) return;
        if (config.ambiguousSend) {
          composer.textContent = composer.textContent + ' [mutated]';
          return;
        }
        window.sent.push({ text: composer.innerText, selected: selectedLabel });
        composer.textContent = '';
        const stop = document.getElementById('stop');
        stop.hidden = false;
        const reply = document.createElement('article');
        reply.setAttribute('data-message-author-role', 'assistant');
        reply.setAttribute('aria-busy', 'true');
        reply.textContent = 'Thinking';
        document.getElementById('replies').append(reply);
        setTimeout(() => {
          reply.textContent = 'Reply ' + window.sent.length;
          reply.setAttribute('aria-busy', 'false');
          stop.hidden = true;
        }, 80);
      };
    </script></body></html>`;
  await context.route('https://m365.cloud.microsoft/chat', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const browser = new CopilotBrowser({
    ...(config.sendConfirmTimeoutMs !== undefined ? { sendConfirmTimeoutMs: config.sendConfirmTimeoutMs } : {}),
    ...(config.sendConfirmPollMs !== undefined ? { sendConfirmPollMs: config.sendConfirmPollMs } : {})
  });
  browser.context = context;
  browser.page = await context.newPage();
  t.after(() => browser.close());
  await browser.page.goto('https://m365.cloud.microsoft/chat');
  return browser;
}

test('Chinese 3-option menu (自动/快速响应/深度思考) selects last option by index; continuations preserve same chat', async t => {
  const browser = await fixture(t, {
    items: [
      { label: '自动', desc: '决定要思考多长时间' },
      { label: '快速响应', desc: '立即回答' },
      { label: '深度思考', desc: '思考更长的时间以获得更好的回答' }
    ]
  });
  if (!browser) return;
  assert.equal((await browser.ask('First task.', { fresh: true })).completed, true);
  const page = browser.page;
  assert.deepEqual(await page.evaluate(() => window.sent), [{ text: 'First task.', selected: '深度思考' }]);
  assert.deepEqual(await page.evaluate(() => window.actions), ['picker', 'item:2']);
  assert.equal((await browser.ask('Tool result.', { requireContinuation: true })).completed, true);
  assert.equal(browser.page, page);
  assert.deepEqual(await page.evaluate(() => window.actions), ['picker', 'item:2']);
  assert.equal((await browser.ask('New task.', { fresh: true })).completed, true);
  assert.notEqual(browser.page, page);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text: 'New task.', selected: '深度思考' }]);
});

test('English and arbitrary renamed model menus select last item purely by index without matching model names', async t => {
  for (const config of [
    {
      items: [
        { label: 'Auto', desc: 'Decides how long to think' },
        { label: 'Quick response', desc: 'Answers right away' },
        { label: 'Think deeper', desc: 'Think longer for better answers' }
      ],
      expected: 'Think deeper'
    },
    {
      pickerId: 'gptModeSwitcher',
      pickerText: 'DefaultMode',
      pickerAriaLabel: 'Model Selector',
      items: [
        { label: 'Mode Alpha', desc: 'First' },
        { label: 'Mode Beta', desc: 'Second' },
        { label: 'Future Model X9', desc: 'Newest' }
      ],
      expected: 'Future Model X9'
    }
  ]) {
    const browser = await fixture(t, config);
    if (!browser) return;
    assert.equal((await browser.ask('Check model.', { fresh: true })).completed, true);
    assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text: 'Check model.', selected: config.expected }]);
    assert.equal(await browser.page.getByRole('menu').count(), 0);
  }
});

test('if last item is already selected, it is left unchanged without redundant click', async t => {
  const browser = await fixture(t, { initialIndex: 2, checkmark: true, keepMenu: true });
  if (!browser) return;
  const result = await browser.selectModel();
  assert.equal(result.selected, true);
  assert.equal(result.alreadySelected, true);
  assert.deepEqual(await browser.page.evaluate(() => window.actions), ['picker']);
  assert.equal(await browser.page.getByRole('menu').count(), 0);
});

test('falls back by index: last -> second-to-last -> first when options fail or are disabled', async t => {
  // Last disabled -> selects second-to-last (Quick response)
  const b1 = await fixture(t, {
    items: [
      { label: 'Auto' },
      { label: 'Quick response' },
      { label: 'Think deeper', disabled: true }
    ]
  });
  if (!b1) return;
  assert.equal((await b1.ask('Fallback disabled.', { fresh: true })).completed, true);
  assert.deepEqual(await b1.page.evaluate(() => window.sent), [{ text: 'Fallback disabled.', selected: 'Quick response' }]);

  // Last ignores clicks -> falls back to second-to-last (快速响应)
  const b2 = await fixture(t, {
    items: [
      { label: '自动' },
      { label: '快速响应' },
      { label: '深度思考', ignore: true }
    ]
  });
  assert.equal((await b2.ask('Fallback ignored last.', { fresh: true })).completed, true);
  assert.deepEqual(await b2.page.evaluate(() => window.sent), [{ text: 'Fallback ignored last.', selected: '快速响应' }]);

  // Last and second-to-last ignore clicks -> falls back to first (自动) without throwing
  const b3 = await fixture(t, {
    items: [
      { label: '自动' },
      { label: '快速响应', ignore: true },
      { label: '深度思考', ignore: true }
    ]
  });
  assert.equal((await b3.ask('Fallback to auto.', { fresh: true })).completed, true);
  assert.deepEqual(await b3.page.evaluate(() => window.sent), [{ text: 'Fallback to auto.', selected: '自动' }]);
});

test('worst-case missing picker, empty menu, or unresponsive options never throw and continue with Auto', async t => {
  for (const scenario of [{ noPicker: true }, { emptyMenu: true }, { ignoreAll: true }]) {
    const browser = await fixture(t, scenario);
    if (!browser) return;
    assert.equal((await browser.ask('Still send with current model.', { fresh: true })).completed, true);
    assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text: 'Still send with current model.', selected: 'Auto' }]);
    assert.equal(await browser.page.getByRole('menu').count(), 0);
  }
});

test('nested submenu expands and selects last leaf option by index', async t => {
  const browser = await fixture(t, {
    hover: true,
    items: [
      { label: 'Auto' },
      { label: 'Models', submenu: true }
    ],
    submenuItems: [
      { label: 'Model Fast' },
      { label: 'Model Deep' }
    ]
  });
  if (!browser) return;
  assert.equal((await browser.ask('Submenu task.', { fresh: true })).completed, true);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text: 'Submenu task.', selected: 'Model Deep' }]);
  assert.equal(await browser.page.getByRole('menu').count(), 0);
});

test('cancellation does not change the selected model', async t => {
  const browser = await fixture(t);
  if (!browser) return;
  await assert.rejects(browser.selectModel({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(await browser.page.evaluate(() => window.actions), []);
});

test('input read-back follows a rebuilt Message Copilot textbox without refilling or resending', async t => {
  const browser = await fixture(t, { initialIndex: 2, rebuildEditor: true, roleEditor: true });
  if (!browser) return;
  const text = 'Inspect C:/project/example.js.\n保留这一行。';
  const statuses = [];
  assert.equal((await browser.ask(text, { fresh: true, onStatus: status => statuses.push(status) })).completed, true);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text, selected: 'Think deeper' }]);
  assert.equal(statuses.some(status => status.startsWith('Retrying input')), false);
});

test('input read-back survives an editor remount longer than the five-second locator timeout', async t => {
  const browser = await fixture(t, { initialIndex: 2, rebuildEditor: true, rebuildDelay: 5500 });
  if (!browser) return;
  browser.context.setDefaultTimeout(5000);
  const text = 'Send the existing draft exactly once.';
  assert.equal((await browser.ask(text, { fresh: true })).completed, true);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text, selected: 'Think deeper' }]);
  assert.deepEqual(await browser.page.evaluate(() => window.inputSelections), ['Think deeper']);
});

test('input read-back stops without refilling or sending if the editor never returns', async t => {
  const browser = await fixture(t, { initialIndex: 2, rebuildEditor: true, rebuildDelay: 60000 });
  if (!browser) return;
  const statuses = [];
  await assert.rejects(browser.ask('Keep this draft.\nDo not resend it.', { fresh: true, onStatus: status => statuses.push(status) }),
    /step=verify-input, timeout=30000ms.*Send was not clicked/);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), []);
  assert.equal(statuses.some(status => status.startsWith('Retrying input')), false);
  assert.equal(browser.busy, false);
});

test('multiple matching editors stop input instead of choosing the first one', async t => {
  const browser = await fixture(t, { initialIndex: 2 });
  if (!browser) return;
  await browser.page.evaluate(() => {
    const second = document.getElementById('m365-chat-editor-target-element').cloneNode(true);
    second.removeAttribute('id');
    document.body.append(second);
  });
  await assert.rejects(browser.ask('Do not enter into an ambiguous editor.', { fresh: true }), /Multiple Copilot input boxes/);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), []);
  assert.deepEqual(await browser.page.evaluate(() => window.inputSelections), []);
});

test('Send retries exactly once when the verified draft remains completely unchanged', async t => {
  const browser = await fixture(t, {
    initialIndex: 2, ignoreSendCount: 1, sendConfirmTimeoutMs: 400, sendConfirmPollMs: 40
  });
  if (!browser) return;
  const statuses = [];
  const reply = await browser.ask('Retry Send once.', { fresh: true, onStatus: status => statuses.push(status) });
  assert.equal(reply.completed, true);
  assert.equal(await browser.page.evaluate(() => window.sendClicks), 2);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), [{ text: 'Retry Send once.', selected: 'Think deeper' }]);
  assert.ok(statuses.some(status => /retrying Send once/i.test(status)));
  assert.equal(browser.uncertain, false);
});

test('Send stops after one retry and reports proven pre-Send failure if draft stays unchanged', async t => {
  const browser = await fixture(t, {
    initialIndex: 2, ignoreSendCount: 10, sendConfirmTimeoutMs: 300, sendConfirmPollMs: 40
  });
  if (!browser) return;
  await assert.rejects(
    browser.ask('Never triggered.', { fresh: true }),
    error => error.code === 'COPILOT_SEND_UNCHANGED' && error.beforeSend === true && error.retryableInFreshChat === true
  );
  assert.equal(await browser.page.evaluate(() => window.sendClicks), 2);
  assert.deepEqual(await browser.page.evaluate(() => window.sent), []);
  assert.equal(browser.uncertain, false);
});

test('ambiguous page changes after Send are never clicked a second time', async t => {
  const browser = await fixture(t, {
    initialIndex: 2, ambiguousSend: true, sendConfirmTimeoutMs: 300, sendConfirmPollMs: 40
  });
  if (!browser) return;
  browser.tab.replyTimeoutMs = 500;
  await assert.rejects(
    browser.ask('Ambiguous send check.', { fresh: true }),
    error => error.beforeSend === false && /Timed out waiting for the current reply/.test(error.message)
  );
  assert.equal(await browser.page.evaluate(() => window.sendClicks), 1);
  assert.equal(browser.uncertain, true);
});
