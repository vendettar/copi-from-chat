import { chromium } from 'playwright-core';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { getCopiPaths } from './paths.js';

export const CHAT_URL = 'https://m365.cloud.microsoft/chat';
const INPUT = '#m365-chat-editor-target-element:is(input, textarea, [contenteditable="true"]):visible, '
  + '[contenteditable="true"][data-lexical-editor="true"]:visible, '
  + '[contenteditable="true"][role="textbox"][aria-label="Message Copilot" i]:visible';
const DEFAULT_COMPOSER_TIMEOUT = 30000;
const DEFAULT_SEND_CONFIRM_TIMEOUT = 5000;
const DEFAULT_SEND_CONFIRM_POLL = 150;
const DEFAULT_REPLY_TIMEOUT = 600000;
const RESPONSES = '[data-testid="markdown-reply"]:visible, [data-message-author-role="assistant"]:visible, [data-author="assistant"]:visible';
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/^[\s\u200B\u200C\uFEFF]+|[\s\u200B\u200C\uFEFF]+$/g, '');

function tagError(error, props) {
  if (error && typeof error === 'object') Object.assign(error, props);
  return error;
}

// Pure positional fallback order: last -> second-to-last -> first.
function candidateIndices(length) {
  if (length <= 0) return [];
  return [...new Set([length - 1, length - 2, 0].filter(index => index >= 0 && index < length))];
}

// Read visible UI controls inside the model selector/menu without relying on hardcoded model names.
function readModelControls(elements) {
  const clean = text => (text ?? '').replace(/[\u200B\u200C\uFEFF]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ').replace(/,?\s*Model Selector\s*$/i, '').trim();
  return elements.map(el => {
    const lines = (el.innerText ?? '').split('\n').map(clean).filter(Boolean);
    const heading = el.querySelector('h4, .fai-CapabilityPickerMenuItem__primaryContentWrapper');
    const state = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed');
    const visibleCheck = [...el.querySelectorAll('svg[data-testid^="checkmark"], svg[class*="checkmark" i], [data-testid*="checkmark" i]')].some(svg => {
      if (!svg.getClientRects().length) return false;
      for (let node = svg; node && node !== el.parentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      return true;
    });
    return {
      labels: [...new Set([clean(heading?.innerText), lines[0], clean(lines.slice(0, 2).join(' ')), clean(el.getAttribute('aria-label'))].filter(Boolean))],
      text: clean(lines.join(' ')).slice(0, 160),
      submenu: /^(?:true|menu|listbox)$/.test(el.getAttribute('aria-haspopup') ?? ''),
      selected: state === null ? visibleCheck : state === 'true',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true'
    };
  });
}

// Runs inside the page for both streaming reads and conversation continuity checks.
function readReply(elements, previous) {
  const last = elements.at(-1);
  if (!last) return { count: 0, text: '', codeBlocks: [], busy: false, finished: false };
  const owner = last.closest('[data-message-author-role="assistant"], [data-author="assistant"]');
  const nodes = owner && owner !== last ? [last, owner] : [last];
  const states = nodes.flatMap(node => ['aria-busy', 'data-is-streaming', 'data-streaming'].map(name => node.getAttribute(name)));
  const body = owner ?? last;
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const pres = [...body.querySelectorAll('pre')];
  if (body.matches('pre')) pres.unshift(body);
  const blocks = new Set(pres.filter(visible).map(pre => pre.querySelector('code') ?? pre));
  for (const code of body.querySelectorAll('code')) {
    if (!code.closest('pre') && visible(code) && /^\s*[\[{]/.test(code.textContent ?? '')) blocks.add(code);
  }
  const readCode = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || /^(BUTTON|STYLE|SCRIPT)$/.test(node.nodeName)) return '';
    if (node.nodeName === 'BR') return '\n';
    let text = '', previousBlock = false;
    for (const child of node.childNodes) {
      if (child.nodeType === Node.COMMENT_NODE || /^(BUTTON|STYLE|SCRIPT)$/.test(child.nodeName)) continue;
      const block = /^(P|DIV)$/.test(child.nodeName);
      if (text && (block || previousBlock) && !text.endsWith('\n')) text += '\n';
      text += readCode(child);
      previousBlock = block;
    }
    return text;
  };
  return {
    count: elements.length, fresh: last !== previous, text: (last.innerText ?? '').replace(/\r\n?/g, '\n'),
    protocolText: (body.innerText ?? '').replace(/\r\n?/g, '\n'),
    codeBlocks: [...blocks].map(readCode),
    busy: states.includes('true'), finished: states.includes('false')
  };
}

export const replyFingerprint = reply => JSON.stringify(reply.codeBlocks?.length ? reply.codeBlocks : [reply.protocolText ?? reply.text ?? '']);

// M365 can remount its editor after input, sometimes exposing only the Message Copilot textbox.
// Read the current DOM with evaluateAll: locator.evaluate waits for a missing element using the
// global 5-second timeout. A missing editor is NOT an empty draft, and multiple matches are unsafe.
function readComposerState(elements) {
  if (elements.length !== 1) return { count: elements.length };
  const el = elements[0];
  // innerText adds visual paragraph spacing; textContent loses <br> boundaries.
  const read = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return '\n';
    const children = [...node.childNodes].filter(child => child.nodeType === Node.ELEMENT_NODE
      || (child.nodeType === Node.TEXT_NODE && child.textContent !== ''));
    // Editable blocks use a final <br> as a caret placeholder. A preceding <br> remains a real newline.
    if ((node === el || /^(P|DIV)$/.test(node.tagName)) && children.at(-1)?.nodeName === 'BR') children.pop();
    let text = '', previousBlock = false;
    for (const [index, child] of children.entries()) {
      const block = child.nodeType === Node.ELEMENT_NODE && /^(P|DIV)$/.test(child.tagName);
      if (index && (block || previousBlock)) text += '\n';
      text += read(child);
      previousBlock = block;
    }
    return text;
  };
  return { count: 1, text: el.matches('input, textarea') ? el.value : read(el), contentEditable: el.isContentEditable };
}

async function readComposer(composer, step) {
  const state = await composer.evaluateAll(readComposerState);
  if (state.count > 1) {
    throw tagError(new Error(`Multiple Copilot input boxes are visible (step=${step}). Send was not clicked.`), { beforeSend: true });
  }
  return state.count === 1 ? state : null;
}

function composerTimeout(step, timeoutMs) {
  return tagError(
    new Error(`The Copilot input box did not become available and stable (step=${step}, timeout=${timeoutMs}ms). Send was not clicked; check the draft in the browser.`),
    { beforeSend: true }
  );
}

async function waitForComposer(composer, { signal, step, timeoutMs = DEFAULT_COMPOSER_TIMEOUT }) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const state = await readComposer(composer, step);
    if (state) return state;
    await delay(100, undefined, { signal });
  } while (Date.now() < deadline);
  throw composerTimeout(step, timeoutMs);
}

function compareInput(actual, expected, contentEditable) {
  const ignored = {}, wanted = expected.split('\n');
  const received = normalize(actual).split('\n').map((line, index) => {
    if (!contentEditable || wanted[index] === undefined || !line.startsWith(wanted[index])) return line;
    const extra = line.slice(wanted[index].length);
    if (!/^[\u200B\u200C\uFEFF]+$/.test(extra)) return line;
    for (const char of extra) {
      const point = 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      ignored[point] = (ignored[point] ?? 0) + 1;
    }
    return wanted[index];
  }).join('\n');
  return { received, matches: received === expected, ignored };
}

export async function waitForChatReady(page, { signal, onStatus = () => {} } = {}) {
  signal?.throwIfAborted();
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!await page.locator(INPUT).first().isVisible()) {
    onStatus('Sign in to Microsoft 365 in the Edge window.');
  }
  await page.locator(INPUT).first().waitFor({ state: 'visible', timeout: 300000 });
}

export async function launchPersistentEdge(profileDir, {
  channel = process.platform === 'win32' ? 'msedge' : 'chrome',
  headless = false
} = {}) {
  await mkdir(profileDir, { recursive: true });
  // Launch adapted from alexistb2904/m365-copilot-browser-provider, e029fe19891621684e6b4172ca79fa3990a52325.
  // MIT license: licenses/m365-copilot-browser-provider.LICENSE.
  const context = await chromium.launchPersistentContext(profileDir, {
    channel, headless, viewport: null, chromiumSandbox: true,
    ignoreDefaultArgs: ['--unsafely-disable-devtools-self-xss-warnings', '--enable-unsafe-swiftshader']
  });
  context.setDefaultTimeout(5000);
  return context;
}

export class CopilotTab {
  page = null;
  busy = false;
  uncertain = false;
  used = false;
  lastReply = null;

  constructor({
    ensurePage,
    openFreshPage,
    onAbortClose,
    withInteractionLock = async fn => fn(),
    diagnosticPath = getCopiPaths().inputDiagnosticFile,
    composerTimeoutMs = DEFAULT_COMPOSER_TIMEOUT,
    sendConfirmTimeoutMs = DEFAULT_SEND_CONFIRM_TIMEOUT,
    sendConfirmPollMs = DEFAULT_SEND_CONFIRM_POLL,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT
  }) {
    this.ensurePage = ensurePage;
    this.openFreshPage = openFreshPage;
    this.onAbortClose = onAbortClose;
    this.withInteractionLock = withInteractionLock;
    this.diagnosticPath = diagnosticPath;
    this.composerTimeoutMs = composerTimeoutMs;
    this.sendConfirmTimeoutMs = sendConfirmTimeoutMs;
    this.sendConfirmPollMs = sendConfirmPollMs;
    this.replyTimeoutMs = replyTimeoutMs;
  }

  async hasContinuation() {
    if (!this.page || this.page.isClosed() || this.uncertain || this.lastReply?.page !== this.page) return false;
    try {
      const reply = await this.page.locator(RESPONSES).evaluateAll(readReply, null);
      return !reply.busy && replyFingerprint(reply) === this.lastReply.signature;
    } catch {
      return false;
    }
  }

  async closePage() {
    const page = this.page;
    this.page = null;
    this.lastReply = null;
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }

  async selectModel({ signal, onStatus = () => {} } = {}) {
    // Maximum-compatibility, index-based model selection:
    // M365 Copilot regularly changes model labels and switches between Chinese and English UI
    // (e.g., [自动, 快速响应, 深度思考] vs [Auto, Quick response, Think deeper] or nested submenus).
    // Never match menu options by hardcoded model name and never fail the turn if selection is
    // unavailable. Try enabled options by index: last -> second-to-last -> first, and fall back
    // gracefully to whatever model is currently active (worst case Auto / 自动).
    signal?.throwIfAborted();
    const page = this.page;
    if (!page || page.isClosed()) return { selected: false, fallback: true, reason: 'no_page' };

    const popupPickerNames = /model|mode|模型|模式|自动|Auto|Quick|快速|Think|深度|Smart|智能|Reason|Deeper|GPT|Claude/i;
    const strictPickerNames = /model selector|select (?:a )?model|选择模型|模型选择|切换模型|^(?:Auto|自动|Quick response|快速响应|快速|Think deeper|深度思考|Smart|智能|Reasoning|Deeper|GPT(?:[\s\u2010-\u2015-].*)?|Claude(?:\s.*)?)$/i;
    const menus = page.locator('[role="menu"]:visible, [role="listbox"]:visible, .fui-MenuPopover:visible, .fui-PopoverSurface:visible');
    const roleItems = menu => menu.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]').filter({ visible: true });
    const fallbackItems = menu => menu.locator('button, [role="button"]').filter({ visible: true });
    const read = async locator => (await locator.evaluateAll(readModelControls))[0];
    const readMenuItems = async menu => {
      const semantic = roleItems(menu);
      const locator = await semantic.count() ? semantic : fallbackItems(menu);
      const infos = await locator.evaluateAll(readModelControls);
      return infos.map((info, index) => ({ info, locator: locator.nth(index) }))
        .filter(({ info }) => !info.disabled);
    };

    const wait = async (find, timeout = 2500) => {
      const deadline = Date.now() + timeout;
      do {
        signal?.throwIfAborted();
        const value = await find();
        if (value) return value;
        await delay(80, undefined, { signal });
      } while (Date.now() < deadline);
      return null;
    };

    const findPicker = async () => {
      const strategies = [
        page.locator('#gptModeSwitcher:visible'),
        page.locator('[data-testid*="model" i]:is(button, [role="button"], [role="combobox"]):visible, [data-test-id*="model" i]:is(button, [role="button"], [role="combobox"]):visible'),
        page.getByRole('button', { name: popupPickerNames }).or(page.getByRole('combobox', { name: popupPickerNames }))
          .and(page.locator('[aria-haspopup]')).filter({ visible: true }),
        page.getByRole('button', { name: strictPickerNames }).or(page.getByRole('combobox', { name: strictPickerNames }))
          .filter({ visible: true })
      ];
      for (const candidates of strategies) {
        const count = await candidates.count();
        for (let i = 0; i < count; i++) {
          const candidate = candidates.nth(i);
          const info = await read(candidate);
          if (info && !info.disabled) return candidate;
        }
      }
      return null;
    };

    const closeMenus = async () => {
      try {
        for (let level = 0; level < 3; level++) {
          const openCount = await menus.count();
          if (level > 0 && !openCount) break;
          if (!openCount && !touchedMenu) break;
          await page.keyboard.press('Escape');
          await delay(50);
          if (!await menus.count()) break;
        }
      } catch { /* Closing a menu must not interfere with execution or abort. */ }
    };

    const ensureTopMenuOpen = async picker => {
      if (await menus.count()) {
        const existing = await readMenuItems(menus.first());
        if (existing.length) return menus.first();
      }
      await picker.click({ timeout: 3000 });
      return wait(async () => {
        if (!await menus.count()) return null;
        const items = await readMenuItems(menus.first());
        return items.length ? menus.first() : null;
      }, 2500);
    };

    let touchedMenu = false;
    try {
      const picker = await wait(findPicker, 2500);
      if (!picker) {
        onStatus('Model selector not found; continuing with current webpage model.');
        return { selected: false, fallback: true, reason: 'picker_not_found' };
      }

      const beforePickerText = (await read(picker))?.text ?? '';
      touchedMenu = true;
      const topMenu = await ensureTopMenuOpen(picker);
      if (!topMenu) {
        onStatus('Model menu unavailable; continuing with current webpage model.');
        return { selected: false, fallback: true, reason: 'menu_not_opened' };
      }

      const trySelectInMenu = async (menuLocator, depth = 0) => {
        const enabled = await readMenuItems(menuLocator);
        if (!enabled.length) return null;

        for (const index of candidateIndices(enabled.length)) {
          signal?.throwIfAborted();
          const currentItems = await readMenuItems(menuLocator);
          const choice = currentItems[index];
          if (!choice) continue;

          // If this entry opens a submenu (e.g., nested model family), expand and pick by index inside it.
          if (choice.info.submenu && depth < 2) {
            const beforeMenuCount = await menus.count();
            try {
              await choice.locator.hover({ timeout: 2000 });
              let subMenu = await wait(async () => (await menus.count()) > beforeMenuCount ? menus.last() : null, 600);
              if (!subMenu && await choice.locator.getAttribute('aria-expanded') !== 'true') {
                await choice.locator.click({ timeout: 2000 });
                subMenu = await wait(async () => (await menus.count()) > beforeMenuCount ? menus.last() : null, 600);
              }
              if (!subMenu) {
                await choice.locator.press('ArrowRight', { timeout: 2000 });
                subMenu = await wait(async () => (await menus.count()) > beforeMenuCount ? menus.last() : null, 800);
              }
              if (subMenu) {
                const nested = await trySelectInMenu(subMenu, depth + 1);
                if (nested) return nested;
              }
            } catch {
              signal?.throwIfAborted();
            }
            continue;
          }

          // Already selected — avoid redundant click that might toggle or flicker.
          if (choice.info.selected) {
            return { selected: true, index, label: choice.info.text || choice.info.labels[0] || '', alreadySelected: true };
          }

          try {
            await choice.locator.click({ timeout: 2500 });
          } catch {
            signal?.throwIfAborted();
            continue;
          }

          // Confirm selection via menu closure, picker text update, or checked state; if the item
          // ignored the click (e.g., locked/upsell entry), fall back to the next candidate index.
          const confirmed = await wait(async () => {
            if (!await menus.count()) return true;
            const afterPickerText = (await read(picker))?.text ?? '';
            if (afterPickerText && afterPickerText !== beforePickerText) return true;
            const refreshed = await readMenuItems(menuLocator);
            if (refreshed[index]?.info.selected) return true;
            return false;
          }, 500);

          if (confirmed) {
            return { selected: true, index, label: choice.info.text || choice.info.labels[0] || '' };
          }
        }
        return null;
      };

      const chosen = await trySelectInMenu(topMenu, 0);
      if (chosen) return chosen;

      onStatus('Could not switch webpage model; continuing with current selection.');
      return { selected: false, fallback: true, reason: 'no_option_confirmed' };
    } catch {
      signal?.throwIfAborted();
      onStatus('Model selection skipped; continuing with current webpage model.');
      return { selected: false, fallback: true, reason: 'selection_error' };
    } finally {
      if (touchedMenu) await closeMenus();
    }
  }

  async ask(message, { signal, fresh = false, requireContinuation = false, onSnapshot = () => {}, onStatus = () => {}, onEvent = () => {} } = {}) {
    if (this.busy) throw tagError(new Error('A browser request is already in progress.'), { beforeSend: true });
    if (this.uncertain && !fresh) {
      throw new Error('The previous exchange is uncertain. Start a new web conversation before sending another request.');
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw tagError(new Error('The message cannot be empty.'), { beforeSend: true });
    }
    signal?.throwIfAborted();

    this.busy = true;
    let sent = false;
    let sendUncertain = false;
    const abort = () => {
      if (this.onAbortClose) void this.onAbortClose().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });

    try {
      signal?.throwIfAborted();
      if (requireContinuation && !await this.hasContinuation()) {
        throw tagError(
          new Error('The previous web conversation is no longer active. Nothing was entered or sent.'),
          { code: 'COPILOT_CONTEXT_LOST', beforeSend: true, retryableInFreshChat: true }
        );
      }
      if (fresh) this.lastReply = null;

      // Serialize only the brief browser UI interaction (focus, model select, fill, verify, Send + 5s confirm)
      // so parallel tabs in a shared Edge window never steal keyboard focus from each other while waiting for replies.
      const sendContext = await this.withInteractionLock(async () => {
        signal?.throwIfAborted();
        await this.ensurePage({ signal, onStatus });
        signal?.throwIfAborted();
        await this.page.bringToFront().catch(() => {});

        const draft = normalize((await waitForComposer(this.page.locator(INPUT), {
          signal, step: 'read-draft', timeoutMs: this.composerTimeoutMs
        })).text);
        if (fresh && (this.used || this.uncertain || await this.page.locator(RESPONSES).count() || draft)) {
          const old = this.page;
          this.page = await this.openFreshPage({ signal, onStatus });
          await this.page.bringToFront().catch(() => {});
          // Keep an existing unsent draft available for inspection in its original tab.
          if (!draft && old && old !== this.page && !old.isClosed()) {
            await old.close().catch(() => {});
          }
          if (await this.page.locator(RESPONSES).count()) {
            const reset = this.page.getByRole('button', {
              name: /^(?:(?:start (?:a )?)?new (?:chat|conversation)|新建聊天|新建对话|新聊天|新对话|开始新聊天)(?:\s*\([^)]*\))?$/i
            }).filter({ visible: true }).first();
            await reset.click();
            await this.page.locator(RESPONSES).first().waitFor({ state: 'hidden', timeout: 15000 });
          }
        }
        if (fresh || !this.used) await this.selectModel({ signal, onStatus });
        if (fresh) this.uncertain = false;

        const page = this.page;
        const composer = page.locator(INPUT);
        const replies = page.locator(RESPONSES);
        const stop = page.locator('button[data-testid="stop-button"]')
          .or(page.getByRole('button', { name: /^(stop(?: generating(?: response)?| responding)?|停止(?:生成|响应|回應)?)(?:\s*\([^)]*\))?$/i }))
          .filter({ visible: true }).first();
        const input = await waitForComposer(composer, { signal, step: 'prepare-input', timeoutMs: this.composerTimeoutMs });
        if (await stop.isVisible()) {
          throw tagError(new Error('The webpage is still generating. Wait for it to finish before trying again.'), { beforeSend: true });
        }
        if (normalize(input.text)) {
          throw tagError(new Error('The webpage contains an unsent draft. Resolve it in the browser before trying again.'), { beforeSend: true });
        }

        const initialReply = await replies.evaluateAll(readReply, null);
        const previousCount = initialReply.count;
        const previous = previousCount ? await replies.last().elementHandle() : null;
        const previousText = previous ? (await previous.innerText()).replace(/\r\n?/g, '\n') : '';
        const previousSignature = replyFingerprint(initialReply);

        const lines = message.replace(/\r\n?/g, '\n').split('\n');
        const contentEditable = input.contentEditable;
        const canUseLineBreaks = lines.length > 1 && contentEditable;
        const expected = normalize(message), attempts = [];
        let actual = '', verified = false;
        let comparison;

        for (const method of canUseLineBreaks ? ['fill', 'lines'] : ['fill']) {
          signal?.throwIfAborted();
          if (method === 'lines') {
            const currentDraft = await waitForComposer(composer, { signal, step: 'retry-input', timeoutMs: this.composerTimeoutMs });
            const count = await replies.count();
            if (await stop.isVisible() || count !== previousCount
              || (count && (await replies.last().innerText()).replace(/\r\n?/g, '\n') !== previousText)
              || !normalize(currentDraft.text)) {
              sendUncertain = true;
              this.uncertain = true;
              throw tagError(
                new Error('The webpage changed during input. Stopped editing the draft; check whether it was submitted.'),
                { beforeSend: false }
              );
            }
            onStatus('Retrying input with explicit line breaks...');
            await composer.fill(lines[0], { timeout: this.composerTimeoutMs });
            for (const line of lines.slice(1)) {
              signal?.throwIfAborted();
              await composer.press('Shift+Enter', { timeout: this.composerTimeoutMs });
              if (line) await page.keyboard.insertText(line);
            }
          } else {
            await composer.fill(message, { timeout: this.composerTimeoutMs });
          }

          const started = Date.now(), samples = [];
          let matchingSince = 0, availableSince = 0;
          do {
            signal?.throwIfAborted();
            const state = await readComposer(composer, 'verify-input');
            const now = Date.now();
            if (!state) {
              matchingSince = availableSince = 0;
            } else {
              availableSince ||= now;
              actual = state.text;
              comparison = compareInput(actual, expected, state.contentEditable);
              const { matches, ignored } = comparison;
              samples.push({ elapsedMs: now - started, length: actual.length, matches, ignored });
              matchingSince = matches ? matchingSince || now : 0;
              if (matchingSince && now - matchingSince >= 500) { verified = true; break; }
              if (now - availableSince >= 3000) break;
            }
            await delay(100, undefined, { signal });
          } while (Date.now() - started < this.composerTimeoutMs);
          if (!verified && Date.now() - started >= this.composerTimeoutMs) {
            throw composerTimeout('verify-input', this.composerTimeoutMs);
          }

          const dom = verified ? undefined : await composer.evaluateAll(elements => {
            if (elements.length !== 1) return { count: elements.length };
            const el = elements[0];
            return {
              tag: el.tagName, contentEditable: el.isContentEditable, focused: el === document.activeElement || el.contains(document.activeElement),
              whiteSpace: getComputedStyle(el).whiteSpace, textTransform: getComputedStyle(el).textTransform, maxLength: el.getAttribute('maxlength'),
              paragraphs: el.querySelectorAll('p').length, lineBreaks: el.querySelectorAll('br').length,
              value: el.matches('input, textarea') ? el.value : null,
              innerText: el.innerText, textContent: el.textContent, html: el.outerHTML
            };
          });
          attempts.push({ method, verified, actual, comparison, samples, dom });
          if (!verified) {
            try {
              await mkdir(dirname(this.diagnosticPath), { recursive: true });
              await writeFile(this.diagnosticPath, JSON.stringify({
                capturedAt: new Date().toISOString(), expected: message,
                reader: 'value for input/textarea; DOM text with paragraph and br boundaries for contenteditable',
                normalization: 'CRLF to LF; trim document boundaries; for contenteditable, ignore extra U+200B/U+200C/U+FEFF suffixes only after an exact match of each expected line',
                attempts
              }, null, 2), 'utf8');
              onStatus(`Input diagnostics saved: ${this.diagnosticPath}`);
            } catch (error) { onStatus(`Could not save input diagnostics: ${error.message}`); }
          }
          if (verified) break;
        }

        if (!verified) {
          const { received } = comparison;
          if (received === expected) {
            throw tagError(
              new Error('Input matched but did not remain stable for 500 ms. Nothing was sent; check the input diagnostics.'),
              { beforeSend: true }
            );
          }
          let offset = 0;
          while (offset < expected.length && expected[offset] === received[offset]) offset++;
          const excerpt = text => JSON.stringify(text.slice(Math.max(0, offset - 30), offset + 90));
          const point = text => offset < text.length ? 'U+' + text.codePointAt(offset).toString(16).toUpperCase().padStart(4, '0') : 'EOF';
          const codes = text => Array.from(text.slice(offset)).slice(0, 8).map(char => 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') || 'EOF';
          throw tagError(
            new Error(`Input verification failed; nothing was sent. Expected ${expected.length} characters, read ${normalize(actual).length}, compared ${received.length}.\nFirst difference at offset ${offset} (zero-based): expected ${point(expected)}, read ${point(received)}.\nCode points: expected ${codes(expected)}; read ${codes(received)}.\nExpected: ${excerpt(expected)}\nRead: ${excerpt(received)}\nDiagnostics: ${this.diagnosticPath}`),
            { beforeSend: true }
          );
        }

        signal?.throwIfAborted();
        if (requireContinuation && (!await this.hasContinuation() || await stop.isVisible())) {
          sendUncertain = true;
          this.uncertain = true;
          throw tagError(
            new Error('The web conversation changed during input. Nothing was sent; inspect the draft before continuing.'),
            { beforeSend: false }
          );
        }

        const sendButton = page.getByRole('button', { name: /^(send(?: message)?|发送|傳送)$/i }).filter({ visible: true }).first();
        const inspectPostSend = async () => {
          const composerState = await composer.evaluateAll(readComposerState);
          const stopVisible = await stop.isVisible();
          const reply = await replies.evaluateAll(readReply, previous);
          const replyChanged = reply.count !== previousCount
            || reply.text !== previousText
            || (reply.count > 0 && reply.fresh)
            || replyFingerprint(reply) !== previousSignature;
          const generating = stopVisible || reply.busy;
          const editorCleared = composerState.count === 1 && !normalize(composerState.text);
          if (editorCleared || generating || replyChanged) {
            return { outcome: 'confirmed', composerState, stopVisible, reply };
          }
          if (composerState.count !== 1) {
            return { outcome: 'ambiguous', composerState, stopVisible, reply };
          }
          const stillUnchanged = compareInput(composerState.text, expected, composerState.contentEditable).matches;
          return { outcome: stillUnchanged ? 'unchanged' : 'ambiguous', composerState, stopVisible, reply };
        };

        // After clicking Send, wait up to 5 seconds for the editor to clear, generation to start,
        // or the reply DOM to change. If the verified draft remains completely unchanged, retry Send
        // exactly once. Ambiguous page changes are never clicked again.
        let sendConfirmed = false;
        for (let sendAttempt = 0; sendAttempt < 2; sendAttempt++) {
          signal?.throwIfAborted();
          if (sendAttempt === 1) {
            onStatus('Draft unchanged after Send; retrying Send once...');
            onEvent({ event: 'send_retry', attempt: 1 });
          } else {
            onEvent({ event: 'send_attempt', attempt: 0 });
          }
          try {
            await sendButton.click({ timeout: 15000 });
          } catch (clickError) {
            signal?.throwIfAborted();
            const probe = await inspectPostSend().catch(() => ({ outcome: 'ambiguous' }));
            if (probe.outcome === 'unchanged') {
              throw tagError(
                new Error(`Could not click Send; the verified draft remained unchanged (${clickError.message.split('\n')[0]}).`),
                { code: 'COPILOT_SEND_CLICK_FAILED', beforeSend: true, retryableInFreshChat: true, cause: clickError }
              );
            }
            sent = true;
            this.used = true;
            throw tagError(clickError, { beforeSend: false });
          }

          const confirmDeadline = Date.now() + this.sendConfirmTimeoutMs;
          let lastOutcome = 'unchanged';
          while (true) {
            signal?.throwIfAborted();
            const probe = await inspectPostSend();
            lastOutcome = probe.outcome;
            if (lastOutcome === 'confirmed' || lastOutcome === 'ambiguous') {
              sent = true;
              this.used = true;
              sendConfirmed = true;
              break;
            }
            if (Date.now() >= confirmDeadline) break;
            await delay(this.sendConfirmPollMs, undefined, { signal });
          }

          if (sendConfirmed) break;
        }

        if (!sendConfirmed) {
          // Verified draft remained completely unchanged after initial Send + single retry;
          // no editor clear, no generation, and no reply DOM change occurred.
          throw tagError(
            new Error('Send did not trigger after one retry; the verified draft remained unchanged. Nothing was submitted.'),
            { code: 'COPILOT_SEND_UNCHANGED', beforeSend: true, retryableInFreshChat: true }
          );
        }

        return { page, replies, stop, previous, previousCount, previousText };
      });

      const { page, replies, stop, previous, previousCount, previousText } = sendContext;
      onStatus('Waiting for Copilot...');

      let sawGenerating = false, lastText = '';
      let candidate = '', candidateSince = 0;
      const deadline = Date.now() + this.replyTimeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const reply = await replies.evaluateAll(readReply, previous);
        const stopVisible = await stop.isVisible();
        const generating = stopVisible || reply.busy;
        sawGenerating ||= generating;
        const current = reply.text.trim() && (reply.count > previousCount || reply.text !== previousText || (sawGenerating && reply.fresh));
        if (current && reply.text !== lastText) {
          await onSnapshot(reply);
          lastText = reply.text;
        }
        if (current && !generating && (sawGenerating || reply.finished)) {
          const signature = JSON.stringify([reply.text, reply.protocolText, reply.codeBlocks]);
          if (candidate !== signature) { candidate = signature; candidateSince = Date.now(); }
          else if (Date.now() - candidateSince >= 1500) {
            signal?.throwIfAborted();
            this.lastReply = { page, signature: replyFingerprint(reply) };
            return { text: reply.text, protocolText: reply.protocolText, codeBlocks: reply.codeBlocks, completed: true };
          }
        } else { candidate = ''; candidateSince = 0; }
        await delay(300, undefined, { signal });
      }
      throw tagError(
        new Error(lastText ? 'Reply text was found, but generation did not finish before the timeout. Its completeness is unconfirmed.' : 'Timed out waiting for the current reply.'),
        { beforeSend: false }
      );
    } catch (error) {
      if (sent || sendUncertain) {
        this.uncertain = true;
        tagError(error, { beforeSend: false });
      } else if (error && typeof error === 'object' && error.beforeSend === undefined) {
        error.beforeSend = true;
      }
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.busy = false;
    }
  }
}

export class CopilotBrowser {
  context = null;
  closed = Promise.resolve();
  closing = Promise.resolve();

  constructor({
    profileDir = getCopiPaths().sharedProfileDir,
    diagnosticPath = getCopiPaths().inputDiagnosticFile,
    channel = process.platform === 'win32' ? 'msedge' : 'chrome',
    headless = false,
    composerTimeoutMs = DEFAULT_COMPOSER_TIMEOUT,
    sendConfirmTimeoutMs = DEFAULT_SEND_CONFIRM_TIMEOUT,
    sendConfirmPollMs = DEFAULT_SEND_CONFIRM_POLL,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT
  } = {}) {
    this.profileDir = profileDir;
    this.channel = channel;
    this.headless = headless;
    this.tab = new CopilotTab({
      diagnosticPath,
      composerTimeoutMs,
      sendConfirmTimeoutMs,
      sendConfirmPollMs,
      replyTimeoutMs,
      ensurePage: options => this.open(options),
      openFreshPage: async options => {
        const page = await this.context.newPage();
        await waitForChatReady(page, options);
        return page;
      },
      onAbortClose: () => this.close()
    });
  }

  get page() { return this.tab.page; }
  set page(value) { this.tab.page = value; }
  get busy() { return this.tab.busy; }
  set busy(value) { this.tab.busy = value; }
  get uncertain() { return this.tab.uncertain; }
  set uncertain(value) { this.tab.uncertain = value; }
  get used() { return this.tab.used; }
  set used(value) { this.tab.used = value; }
  get lastReply() { return this.tab.lastReply; }
  set lastReply(value) { this.tab.lastReply = value; }

  async hasContinuation() {
    if (!this.context) return false;
    return this.tab.hasContinuation();
  }

  async selectModel(options = {}) {
    return this.tab.selectModel(options);
  }

  async open({ signal, onStatus = () => {} } = {}) {
    await this.closing;
    signal?.throwIfAborted();
    if (this.context && !this.page?.isClosed()) return;
    this.context = await launchPersistentEdge(this.profileDir, { channel: this.channel, headless: this.headless });
    const context = this.context;
    this.closed = new Promise(resolve => context.once('close', resolve));
    try {
      signal?.throwIfAborted();
      this.page = context.pages()[0] ?? await context.newPage();
      await waitForChatReady(this.page, { signal, onStatus });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async ask(message, options = {}) {
    return this.tab.ask(message, options);
  }

  async close() {
    this.lastReply = null;
    const context = this.context;
    if (context) {
      this.context = null;
      this.page = null;
      this.closing = context.close();
    }
    await this.closing;
  }
}
