import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotTab, launchPersistentEdge, waitForChatReady } from './browser.js';
import { getCopiPaths } from './paths.js';
import { logActivity, readConfig } from './storage.js';

const MAX_IDLE_TABS = 16;
const HEARTBEAT_MS = 15000;

function createMutex() {
  let chain = Promise.resolve();
  return async fn => {
    const previous = chain;
    let release;
    chain = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function writeFileAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, filePath);
}

export async function startBrowserHost({
  copiHome,
  paths = getCopiPaths(copiHome),
  profileDir = paths.sharedProfileDir,
  channel = process.platform === 'win32' ? 'msedge' : 'chrome',
  headless = false,
  context: injectedContext = null,
  version = '0.1.2',
  idleTimeoutMinutes,
  sendConfirmTimeoutMs,
  sendConfirmPollMs,
  composerTimeoutMs,
  replyTimeoutMs,
  onShutdown = () => {}
} = {}) {
  const token = randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();
  const withInteractionLock = createMutex();
  const sessions = new Map();

  let context = injectedContext;
  let contextLaunchPromise = null;
  let initialPageAdopted = false;
  let closed = false;

  const ensureContext = async () => {
    if (context) return context;
    if (!contextLaunchPromise) {
      contextLaunchPromise = (async () => {
        const launched = await launchPersistentEdge(profileDir, { channel, headless });
        context = launched;
        launched.once('close', () => {
          context = null;
          contextLaunchPromise = null;
          void shutdown('browser_closed');
        });
        return launched;
      })();
      contextLaunchPromise.catch(() => { contextLaunchPromise = null; });
    }
    return contextLaunchPromise;
  };

  if (injectedContext) {
    injectedContext.once('close', () => {
      context = null;
      void shutdown('browser_closed');
    });
  }

  const evictIdleTabsIfNeeded = async () => {
    const idle = [...sessions.entries()]
      .filter(([, entry]) => entry.attachedCount <= 0 && !entry.tab.busy && entry.tab.page && !entry.tab.page.isClosed())
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    while (idle.length > MAX_IDLE_TABS) {
      const [id, entry] = idle.shift();
      await entry.tab.closePage();
      sessions.delete(id);
      await logActivity(paths, 'tab_evict', { sessionId: id });
    }
  };

  const openPageForContext = async (ctx, options) => {
    const pages = ctx.pages();
    const reusableBlank = !initialPageAdopted && pages.length === 1 && !pages[0].isClosed()
      && (!pages[0].url() || pages[0].url() === 'about:blank');
    const page = reusableBlank ? pages[0] : await ctx.newPage();
    initialPageAdopted = true;
    await waitForChatReady(page, options);
    return page;
  };

  const getOrCreateSession = sessionId => {
    let entry = sessions.get(sessionId);
    if (entry) {
      entry.lastActiveAt = Date.now();
      return { entry, reused: Boolean(entry.tab.page && !entry.tab.page.isClosed()) };
    }
    const tab = new CopilotTab({
      diagnosticPath: paths.inputDiagnosticFile,
      withInteractionLock,
      ...(sendConfirmTimeoutMs !== undefined ? { sendConfirmTimeoutMs } : {}),
      ...(sendConfirmPollMs !== undefined ? { sendConfirmPollMs } : {}),
      ...(composerTimeoutMs !== undefined ? { composerTimeoutMs } : {}),
      ...(replyTimeoutMs !== undefined ? { replyTimeoutMs } : {}),
      ensurePage: async options => {
        const ctx = await ensureContext();
        if (tab.page && !tab.page.isClosed()) return;
        tab.page = await openPageForContext(ctx, options);
        await logActivity(paths, 'tab_open', { sessionId });
      },
      openFreshPage: async options => {
        const ctx = await ensureContext();
        const page = await ctx.newPage();
        initialPageAdopted = true;
        await waitForChatReady(page, options);
        await logActivity(paths, 'tab_open', { sessionId, fresh: true });
        return page;
      },
      onAbortClose: async () => {
        // Only close this session's tab page on abort; never close the shared Edge window.
        await tab.closePage();
      }
    });
    entry = {
      sessionId,
      tab,
      lastTurn: null,
      attachedCount: 0,
      lastActiveAt: Date.now(),
      activeAbort: null
    };
    sessions.set(sessionId, entry);
    return { entry, reused: false };
  };

  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          version,
          startedAt,
          browserOpen: Boolean(context),
          tabs: [...sessions.values()].map(entry => ({
            sessionId: entry.sessionId,
            open: Boolean(entry.tab.page && !entry.tab.page.isClosed()),
            busy: entry.tab.busy,
            uncertain: entry.tab.uncertain,
            attachedCount: entry.attachedCount
          }))
        });
      }

      if (req.method === 'POST' && pathname === '/shutdown') {
        sendJson(res, 200, { ok: true });
        setImmediate(() => void shutdown('api_shutdown'));
        return;
      }

      const match = /^\/sessions\/([^/]+)\/(attach|continuation|turn|ask|abort|detach|warm|models|model|reset|status|dom-health)$/.exec(pathname);
      if (!match) return sendJson(res, 404, { error: 'Not found' });

      const sessionId = decodeURIComponent(match[1]);
      const action = match[2];

      if (req.method === 'GET' && action === 'dom-health') {
        const entry = sessions.get(sessionId);
        const health = entry
          ? await entry.tab.inspectDomHealth()
          : { pageOpen: false, composerCount: 0, sendButtonVisible: false, pickerFound: false, replyCount: 0 };
        return sendJson(res, 200, health);
      }

      if (req.method === 'GET' && action === 'status') {
        const entry = sessions.get(sessionId);
        const tabStatus = entry
          ? await entry.tab.getStatus()
          : { state: 'disconnected', ready: false, open: false, busy: false, uncertain: false, activeModel: null };
        return sendJson(res, 200, {
          ...tabStatus,
          hostPid: process.pid,
          port: server.address()?.port ?? null,
          browserOpen: Boolean(context)
        });
      }

      if (req.method === 'POST' && action === 'reset') {
        const body = await readJsonBody(req);
        const { entry } = getOrCreateSession(sessionId);
        entry.lastActiveAt = Date.now();
        if (entry.activeAbort) entry.activeAbort.abort();
        entry.lastTurn = null;
        await entry.tab.resetTab({ warm: Boolean(body.warm) });
        await logActivity(paths, 'tab_reset', { sessionId, warm: Boolean(body.warm) });
        return sendJson(res, 200, { ok: true, reset: true });
      }

      if (req.method === 'POST' && action === 'warm') {
        const body = await readJsonBody(req);
        const { entry } = getOrCreateSession(sessionId);
        entry.lastActiveAt = Date.now();
        if (body.modelPreference !== undefined) {
          await entry.tab.setModelPreference(body.modelPreference, { applyNow: false });
        }
        const pending = entry.tab.warm({});
        if (body.wait) {
          const result = await pending;
          return sendJson(res, 200, { ok: true, ...result });
        }
        pending.catch(() => {});
        return sendJson(res, 200, { ok: true, ready: await entry.tab.isReady(), warming: true });
      }

      if (req.method === 'GET' && action === 'models') {
        const openIfNeeded = url.searchParams.get('open') === '1';
        let entry = sessions.get(sessionId);
        if (!entry) {
          if (!openIfNeeded) {
            return sendJson(res, 200, { ready: false, current: null, models: [], reason: 'not_open' });
          }
          entry = getOrCreateSession(sessionId).entry;
        }
        entry.lastActiveAt = Date.now();
        const result = await entry.tab.listModels({ openIfNeeded });
        return sendJson(res, 200, { ...result, preference: entry.tab.modelPreference });
      }

      if (req.method === 'POST' && action === 'model') {
        const body = await readJsonBody(req);
        const { entry } = getOrCreateSession(sessionId);
        entry.lastActiveAt = Date.now();
        const result = await entry.tab.setModelPreference(body.preference, {
          applyNow: body.applyNow !== false
        });
        await logActivity(paths, 'model_change', {
          sessionId,
          preference: result.preference,
          applied: result.applied,
          selectedLabel: result.result?.label ?? null
        });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && action === 'attach') {
        const { entry, reused } = getOrCreateSession(sessionId);
        entry.attachedCount++;
        entry.lastActiveAt = Date.now();
        const hasContinuation = reused ? await entry.tab.hasContinuation() : false;
        await logActivity(paths, reused ? 'tab_reuse' : 'tab_attach', { sessionId, hasContinuation });
        await evictIdleTabsIfNeeded();
        return sendJson(res, 200, {
          sessionId,
          reused,
          hasContinuation,
          uncertain: entry.tab.uncertain,
          lastTurn: hasContinuation ? entry.lastTurn : null
        });
      }

      if (req.method === 'GET' && action === 'continuation') {
        const entry = sessions.get(sessionId);
        if (!entry || !entry.tab.page || entry.tab.page.isClosed()) {
          return sendJson(res, 200, { hasContinuation: false, uncertain: false, lastTurn: null });
        }
        const hasContinuation = await entry.tab.hasContinuation();
        return sendJson(res, 200, {
          hasContinuation,
          uncertain: entry.tab.uncertain,
          lastTurn: hasContinuation ? entry.lastTurn : null
        });
      }

      if (req.method === 'POST' && action === 'turn') {
        const body = await readJsonBody(req);
        const { entry } = getOrCreateSession(sessionId);
        entry.lastTurn = body.lastTurn ?? null;
        entry.lastActiveAt = Date.now();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && action === 'abort') {
        const entry = sessions.get(sessionId);
        if (entry?.activeAbort) {
          entry.activeAbort.abort();
        }
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && action === 'detach') {
        const body = await readJsonBody(req);
        const entry = sessions.get(sessionId);
        if (entry) {
          entry.attachedCount = Math.max(0, entry.attachedCount - 1);
          entry.lastActiveAt = Date.now();
          if (entry.activeAbort) entry.activeAbort.abort();
          if (body.closeTab && entry.attachedCount === 0 && !entry.tab.busy) {
            await entry.tab.closePage();
            sessions.delete(sessionId);
            await logActivity(paths, 'tab_close', { sessionId, reason: body.reason ?? 'detach' });
          }
        }
        await evictIdleTabsIfNeeded();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && action === 'ask') {
        const body = await readJsonBody(req);
        const { entry } = getOrCreateSession(sessionId);
        entry.lastActiveAt = Date.now();
        const controller = new AbortController();
        entry.activeAbort = controller;

        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive'
        });

        const writeEvent = event => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(`${JSON.stringify(event)}\n`);
          }
        };

        const heartbeat = setInterval(() => writeEvent({ type: 'heartbeat' }), HEARTBEAT_MS);
        heartbeat.unref();

        req.once('close', () => {
          if (!res.writableEnded) controller.abort();
        });

        try {
          const reply = await entry.tab.ask(body.message, {
            signal: controller.signal,
            fresh: Boolean(body.fresh),
            requireContinuation: Boolean(body.requireContinuation),
            ...(body.modelPreference !== undefined ? { modelPreference: body.modelPreference } : {}),
            ...(body.turnContext !== undefined ? { turnContext: body.turnContext } : {}),
            onStatus: message => writeEvent({ type: 'status', message }),
            onSnapshot: snapshot => writeEvent({ type: 'snapshot', snapshot }),
            onEvent: detail => {
              void logActivity(paths, detail.event, { sessionId, attempt: detail.attempt });
            }
          });
          entry.lastActiveAt = Date.now();
          writeEvent({ type: 'result', reply });
        } catch (error) {
          writeEvent({
            type: 'error',
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            code: error?.code,
            beforeSend: error?.beforeSend,
            retryableInFreshChat: error?.retryableInFreshChat,
            limitNotice: error?.limitNotice,
            effectivePref: error?.effectivePref,
            uncertain: entry.tab.uncertain
          });
        } finally {
          clearInterval(heartbeat);
          if (entry.activeAbort === controller) entry.activeAbort = null;
          if (!res.writableEnded) res.end();
        }
        return;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      sendJson(res, 500, { error: error?.message ?? String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address();
  const descriptor = {
    pid: process.pid,
    host: '127.0.0.1',
    port,
    token,
    profileDir,
    startedAt,
    version
  };
  await writeFileAtomic(paths.browserHostFile, JSON.stringify(descriptor, null, 2));
  await logActivity(paths, 'browser_host_start', { port, profileDir });

  // Optional idle auto-shutdown when configured via ~/.copi/config.json (hostIdleMinutes).
  const cfg = await readConfig(paths).catch(() => ({}));
  const configuredIdleMin = idleTimeoutMinutes ?? (Number(cfg.hostIdleMinutes) > 0 ? Number(cfg.hostIdleMinutes) : 0);
  let idleCheckTimer = null;
  let lastActivityMs = Date.now();
  if (configuredIdleMin > 0) {
    const idleMs = configuredIdleMin * 60 * 1000;
    idleCheckTimer = setInterval(() => {
      const anyActive = [...sessions.values()].some(e => e.attachedCount > 0 || e.tab.busy);
      if (anyActive) {
        lastActivityMs = Date.now();
        return;
      }
      if (Date.now() - lastActivityMs >= idleMs) {
        void shutdown('idle_timeout');
      }
    }, Math.min(30000, Math.max(1000, Math.floor(idleMs / 2))));
    idleCheckTimer.unref();
  }

  async function shutdown(reason = 'shutdown') {
    if (closed) return;
    closed = true;
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    for (const entry of sessions.values()) {
      entry.activeAbort?.abort();
    }
    try {
      const currentRaw = await readFile(paths.browserHostFile, 'utf8');
      const current = JSON.parse(currentRaw);
      if (current.token === token) {
        await unlink(paths.browserHostFile).catch(() => {});
      }
    } catch { /* already gone */ }

    const ctx = context;
    context = null;
    if (ctx) {
      await ctx.close().catch(() => {});
    }
    await new Promise(resolve => server.close(() => resolve()));
    await logActivity(paths, 'browser_host_stop', { reason });
    onShutdown(reason);
  }

  return {
    descriptor,
    server,
    sessions,
    shutdown
  };
}

// Run as detached daemon when invoked directly.
const thisFile = resolvePath(fileURLToPath(import.meta.url));
const entryFile = process.argv[1] ? resolvePath(process.argv[1]) : '';
const isDirectMain = Boolean(entryFile) && (process.platform === 'win32'
  ? thisFile.toLowerCase() === entryFile.toLowerCase()
  : thisFile === entryFile);
if (isDirectMain) {
  let host;
  const finish = () => {
    if (host) void host.shutdown('signal').finally(() => process.exit(0));
    else process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  try {
    host = await startBrowserHost({
      onShutdown: () => process.exit(0)
    });
  } catch (error) {
    console.error(`Browser host failed to start: ${error.message}`);
    process.exit(1);
  }
}
