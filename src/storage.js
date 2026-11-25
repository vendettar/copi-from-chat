import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const STALE_CORRUPT_MS = 5000;

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user/privilege level.
    return error?.code === 'EPERM';
  }
}

function safeLockFilename(key) {
  return `${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.lock`;
}

async function readLockRecord(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    return { raw, data: JSON.parse(raw) };
  } catch {
    return null;
  }
}

async function tryBreakStaleLock(lockPath) {
  const existing = await readLockRecord(lockPath);
  if (existing?.data && Number.isInteger(existing.data.pid)) {
    if (isPidAlive(existing.data.pid)) return { stale: false, existing: existing.data };
    await unlink(lockPath).catch(() => {});
    return { stale: true };
  }
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs >= STALE_CORRUPT_MS) {
      await unlink(lockPath).catch(() => {});
      return { stale: true };
    }
    return { stale: false, existing: null };
  } catch (error) {
    return error?.code === 'ENOENT' ? { stale: true } : { stale: false, existing: null };
  }
}

export async function acquireLock(locksDir, key, meta = {}, {
  timeoutMs = 0,
  pollMs = 100,
  signal,
  ownerId = randomUUID()
} = {}) {
  await mkdir(locksDir, { recursive: true });
  const lockPath = join(locksDir, safeLockFilename(key));
  const payload = {
    pid: process.pid,
    ownerId,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...meta
  };
  const deadline = Date.now() + timeoutMs;

  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: lockPath,
        ownerId,
        meta: payload,
        async release() {
          if (released) return;
          released = true;
          const current = await readLockRecord(lockPath);
          if (current?.data?.ownerId === ownerId) {
            await unlink(lockPath).catch(() => {});
          }
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const check = await tryBreakStaleLock(lockPath);
      if (check.stale) continue;
      if (Date.now() >= deadline) {
        const holder = check.existing?.pid ? ` (PID ${check.existing.pid})` : '';
        const err = new Error(`Lock "${key}" is currently held by another active copi process${holder}.`);
        err.code = 'COPI_LOCKED';
        err.lock = check.existing ?? null;
        throw err;
      }
      await delay(pollMs, undefined, { signal });
    }
  }
}

export async function inspectLock(locksDir, key) {
  const lockPath = join(locksDir, safeLockFilename(key));
  const check = await tryBreakStaleLock(lockPath);
  if (check.stale) return null;
  return check.existing ?? { unknown: true };
}

export async function isLockedByOther(locksDir, key, currentOwnerId) {
  const active = await inspectLock(locksDir, key);
  if (!active) return false;
  if (currentOwnerId && active.ownerId === currentOwnerId) return false;
  return true;
}

export function acquireSessionLock(paths, sessionId, options = {}) {
  return acquireLock(paths.locksDir, `session-${sessionId}`, { kind: 'session', sessionId }, options);
}

export function acquireProfileLock(paths, profileName, options = {}) {
  return acquireLock(paths.locksDir, `profile-${profileName}`, { kind: 'profile', profile: profileName }, options);
}

export async function withStartupLock(paths, fn, { timeoutMs = 20000, pollMs = 100, signal } = {}) {
  const lock = await acquireLock(paths.locksDir, 'browser-host-startup', { kind: 'startup' }, {
    timeoutMs,
    pollMs,
    signal
  });
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

export async function logActivity(paths, event, data = {}) {
  if (!paths?.activityLog) return;
  try {
    await mkdir(dirname(paths.activityLog), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...data
    });
    await appendFile(paths.activityLog, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Activity logging is diagnostic and must never break agent execution.
  }
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const summary = {};
  for (const key of ['path', 'command', 'pattern', 'glob']) {
    if (typeof args[key] === 'string') {
      summary[key] = args[key].length > 200 ? `${args[key].slice(0, 200)}...` : args[key];
    }
  }
  return summary;
}

export async function recordToolCheckpoint(paths, entry) {
  if (!paths?.checkpointsDir || !entry?.sessionId) return;
  try {
    await mkdir(paths.checkpointsDir, { recursive: true });
    const file = join(paths.checkpointsDir, `${String(entry.sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      sessionId: entry.sessionId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      phase: entry.phase,
      ...(entry.args !== undefined ? { args: summarizeToolArgs(entry.args) } : {}),
      ...(entry.isError !== undefined ? { isError: Boolean(entry.isError) } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {})
    };
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Checkpoint persistence is best-effort and must not disrupt tool execution.
  }
}

export async function readIncompleteCheckpoints(paths, sessionId) {
  if (!paths?.checkpointsDir || !sessionId) return [];
  const file = join(paths.checkpointsDir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const started = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.toolCallId) continue;
    if (entry.phase === 'started') started.set(entry.toolCallId, entry);
    else if (entry.phase === 'completed' || entry.phase === 'error') started.delete(entry.toolCallId);
  }
  return [...started.values()];
}

export async function readConfig(paths) {
  if (!paths?.configFile) return {};
  try {
    const raw = await readFile(paths.configFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveConfig(paths, patch = {}) {
  if (!paths?.configFile) return {};
  const next = { ...(await readConfig(paths)), ...patch };
  await mkdir(dirname(paths.configFile), { recursive: true });
  const temp = `${paths.configFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, paths.configFile);
  return next;
}
