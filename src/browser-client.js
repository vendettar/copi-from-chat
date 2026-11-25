import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getCopiPaths } from './paths.js';
import { DEFAULT_MODEL_PREFERENCE, parseModelPreference } from './model-preference.js';
import { isPidAlive, logActivity, withStartupLock } from './storage.js';

const HOST_SCRIPT = fileURLToPath(new URL('./browser-host.js', import.meta.url));
const STARTUP_TIMEOUT_MS = 20000;

function hostUrl(info, path) {
  return `http://${info.host}:${info.port}${path}`;
}

async function readHostDescriptor(paths) {
  try {
    const raw = await readFile(paths.browserHostFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.host === 'string' && Number.isInteger(data.port) && typeof data.token === 'string') {
      return data;
    }
  } catch { /* missing or corrupt */ }
  return null;
}

async function checkHostHealth(info, { signal, timeoutMs = 2000 } = {}) {
  if (!info) return null;
  if (info.pid && !isPidAlive(info.pid)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(hostUrl(info, '/health'), {
      headers: { authorization: `Bearer ${info.token}` },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function findRunningBrowserHost(paths = getCopiPaths(), { signal } = {}) {
  const info = await readHostDescriptor(paths);
  if (!info) return null;
  const health = await checkHostHealth(info, { signal });
  if (health) return info;
  return null;
}

export async function ensureBrowserHost(paths = getCopiPaths(), {
  signal,
  spawnHost,
  startupTimeoutMs = STARTUP_TIMEOUT_MS
} = {}) {
  const existing = await findRunningBrowserHost(paths, { signal });
  if (existing) return existing;

  return withStartupLock(paths, async () => {
    const rechecked = await findRunningBrowserHost(paths, { signal });
    if (rechecked) return rechecked;

    // Remove stale descriptor before spawning a fresh Browser Host.
    const stale = await readHostDescriptor(paths);
    if (stale && (!stale.pid || !isPidAlive(stale.pid))) {
      await unlink(paths.browserHostFile).catch(() => {});
    }

    if (spawnHost) {
      await spawnHost(paths);
    } else {
      const child = spawn(process.execPath, [HOST_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, COPI_HOME: paths.home }
      });
      child.unref();
    }

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const ready = await findRunningBrowserHost(paths, { signal });
      if (ready) {
        await logActivity(paths, 'browser_host_connect', { port: ready.port, pid: ready.pid });
        return ready;
      }
      await delay(100, undefined, { signal });
    }
    throw Object.assign(
      new Error('Timed out starting the shared Browser Host.'),
      { code: 'COPILOT_HOST_START_TIMEOUT', beforeSend: true }
    );
  }, { timeoutMs: startupTimeoutMs, signal });
}

export class SharedBrowserClient {
  mode = 'shared';
  busy = false;
  uncertain = false;
  lastSelectedModel = null;

  constructor({
    paths = getCopiPaths(),
    sessionId,
    modelPreference = DEFAULT_MODEL_PREFERENCE,
    spawnHost,
    startupTimeoutMs = STARTUP_TIMEOUT_MS
  }) {
    if (!sessionId) throw new Error('SharedBrowserClient requires a sessionId.');
    this.paths = paths;
    this.sessionId = sessionId;
    this.modelPreference = parseModelPreference(modelPreference);
    this.spawnHost = spawnHost;
    this.startupTimeoutMs = startupTimeoutMs;
    this.hostInfo = null;
    this.attached = false;
  }

  async _connect({ startIfMissing = true, signal } = {}) {
    if (this.hostInfo) {
      const health = await checkHostHealth(this.hostInfo, { signal });
      if (health) return this.hostInfo;
      this.hostInfo = null;
      this.attached = false;
    }
    this.hostInfo = startIfMissing
      ? await ensureBrowserHost(this.paths, {
        signal,
        spawnHost: this.spawnHost,
        startupTimeoutMs: this.startupTimeoutMs
      })
      : await findRunningBrowserHost(this.paths, { signal });
    return this.hostInfo;
  }

  async _request(info, method, path, body, { signal } = {}) {
    const response = await fetch(hostUrl(info, path), {
      method,
      headers: {
        authorization: `Bearer ${info.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Browser Host HTTP ${response.status}: ${text || response.statusText}`);
    }
    return response;
  }

  async attach({ signal } = {}) {
    const info = await this._connect({ startIfMissing: true, signal });
    const response = await this._request(info, 'POST', `/sessions/${encodeURIComponent(this.sessionId)}/attach`, {}, { signal });
    this.attached = true;
    return response.json();
  }

  async getContinuationState(sessionId = this.sessionId, { signal } = {}) {
    const info = await this._connect({ startIfMissing: false, signal });
    if (!info) return { hasContinuation: false, uncertain: false, lastTurn: null };
    try {
      const response = await this._request(info, 'GET', `/sessions/${encodeURIComponent(sessionId)}/continuation`, undefined, { signal });
      return await response.json();
    } catch {
      return { hasContinuation: false, uncertain: false, lastTurn: null };
    }
  }

  async saveTurnState(sessionId, lastTurn) {
    const info = await this._connect({ startIfMissing: false });
    if (!info) return;
    try {
      await this._request(info, 'POST', `/sessions/${encodeURIComponent(sessionId)}/turn`, { lastTurn });
    } catch { /* best effort */ }
  }

  async hasContinuation() {
    const state = await this.getContinuationState(this.sessionId);
    return Boolean(state?.hasContinuation);
  }

  async warm({ wait = false, signal } = {}) {
    const info = await this._connect({ startIfMissing: true, signal });
    if (!this.attached) await this.attach({ signal });
    const response = await this._request(info, 'POST', `/sessions/${encodeURIComponent(this.sessionId)}/warm`, {
      wait: Boolean(wait),
      modelPreference: this.modelPreference
    }, { signal });
    return response.json();
  }

  async listModels({ openIfNeeded = false, signal } = {}) {
    const info = await this._connect({ startIfMissing: openIfNeeded, signal });
    if (!info) return { ready: false, current: this.lastSelectedModel, models: [], reason: 'not_open' };
    if (openIfNeeded && !this.attached) await this.attach({ signal });
    const query = openIfNeeded ? '?open=1' : '';
    const response = await this._request(info, 'GET', `/sessions/${encodeURIComponent(this.sessionId)}/models${query}`, undefined, { signal });
    const data = await response.json();
    if (data?.current) this.lastSelectedModel = data.current;
    return data;
  }

  async setModelPreference(preference, { applyNow = true, signal } = {}) {
    const parsed = parseModelPreference(preference);
    this.modelPreference = parsed;
    const info = await this._connect({ startIfMissing: false, signal });
    if (!info) return { preference: parsed, applied: false, reason: 'not_open' };
    try {
      const response = await this._request(info, 'POST', `/sessions/${encodeURIComponent(this.sessionId)}/model`, {
        preference: parsed,
        applyNow
      }, { signal });
      const data = await response.json();
      if (data?.result?.label) this.lastSelectedModel = data.result.label;
      return data;
    } catch {
      return { preference: parsed, applied: false, reason: 'host_unreachable' };
    }
  }

  async ask(message, { signal, fresh = false, requireContinuation = false, modelPreference, onSnapshot = () => {}, onStatus = () => {} } = {}) {
    if (this.busy) {
      throw Object.assign(new Error('A browser request is already in progress.'), { beforeSend: true });
    }
    signal?.throwIfAborted();
    this.busy = true;

    let info;
    try {
      if (requireContinuation) {
        info = await this._connect({ startIfMissing: false, signal });
        if (!info) {
          throw Object.assign(
            new Error('The shared Browser Host is no longer running. Nothing was entered or sent.'),
            { code: 'COPILOT_CONTEXT_LOST', beforeSend: true, retryableInFreshChat: true }
          );
        }
      } else {
        info = await this._connect({ startIfMissing: true, signal });
        if (!this.attached) await this.attach({ signal });
      }
    } catch (error) {
      this.busy = false;
      throw error;
    }

    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      void this._request(info, 'POST', `/sessions/${encodeURIComponent(this.sessionId)}/abort`, {}).catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let streamStarted = false;
    try {
      const response = await fetch(hostUrl(info, `/sessions/${encodeURIComponent(this.sessionId)}/ask`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${info.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          message,
          fresh,
          requireContinuation,
          modelPreference: modelPreference !== undefined ? parseModelPreference(modelPreference) : this.modelPreference
        }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw Object.assign(
          new Error(`Browser Host request failed (${response.status}): ${text || response.statusText}`),
          { beforeSend: true }
        );
      }

      streamStarted = true;
      const decoder = new TextDecoder();
      let buffer = '';
      let finalResult = null;
      let streamError = null;

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = JSON.parse(line);
            if (event.type === 'status') onStatus(event.message);
            else if (event.type === 'snapshot') await onSnapshot(event.snapshot);
            else if (event.type === 'result') finalResult = event.reply;
            else if (event.type === 'error') {
              if (event.uncertain) this.uncertain = true;
              const err = new Error(event.message);
              if (event.name) err.name = event.name;
              if (event.code) err.code = event.code;
              if (event.beforeSend !== undefined) err.beforeSend = event.beforeSend;
              if (event.retryableInFreshChat !== undefined) err.retryableInFreshChat = event.retryableInFreshChat;
              streamError = err;
            }
          }
          newline = buffer.indexOf('\n');
        }
      }

      if (streamError) throw streamError;
      if (!finalResult) {
        throw Object.assign(
          new Error('Connection to the Browser Host ended before a reply was confirmed.'),
          { beforeSend: false }
        );
      }
      this.uncertain = false;
      return finalResult;
    } catch (error) {
      signal?.throwIfAborted();
      if (!streamStarted && requireContinuation) {
        this.hostInfo = null;
        this.attached = false;
        throw Object.assign(
          new Error('Lost connection to the shared Browser Host before Send. Nothing was entered or sent.'),
          { code: 'COPILOT_CONTEXT_LOST', beforeSend: true, retryableInFreshChat: true, cause: error }
        );
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.busy = false;
    }
  }

  async detach({ closeTab = false, reason = 'detach' } = {}) {
    if (!this.hostInfo) return;
    const info = this.hostInfo;
    this.attached = false;
    try {
      await this._request(info, 'POST', `/sessions/${encodeURIComponent(this.sessionId)}/detach`, { closeTab, reason });
    } catch { /* host may already have closed */ }
  }

  async close({ closeTab = false } = {}) {
    await this.detach({ closeTab, reason: 'session_shutdown' });
  }
}
