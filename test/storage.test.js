import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCopiDirs, getCopiPaths, normalizeCliPath, validateProfileName } from '../src/paths.js';
import {
  acquireLock, acquireProfileLock, acquireSessionLock, isLockedByOther,
  logActivity, readIncompleteCheckpoints, recordToolCheckpoint, withStartupLock
} from '../src/storage.js';

test('paths helper resolves ~/.copi layout, validates profiles, and normalizes Git Bash paths on Windows', () => {
  const paths = getCopiPaths('/tmp/test-copi-home');
  assert.equal(paths.sessionsDir, join('/tmp/test-copi-home', 'sessions'));
  assert.equal(paths.sharedProfileDir, join('/tmp/test-copi-home', 'shared-browser-profile'));
  assert.equal(paths.browserProfilesDir, join('/tmp/test-copi-home', 'browser-profiles'));
  assert.equal(paths.profileDir('work-1'), join('/tmp/test-copi-home', 'browser-profiles', 'work-1'));
  assert.equal(paths.activityLog, join('/tmp/test-copi-home', 'activity.jsonl'));
  assert.equal(paths.checkpointsDir, join('/tmp/test-copi-home', 'checkpoints'));
  assert.equal(paths.locksDir, join('/tmp/test-copi-home', 'locks'));
  assert.equal(paths.browserHostFile, join('/tmp/test-copi-home', 'browser-host.json'));

  assert.equal(validateProfileName('work_2.0-a'), 'work_2.0-a');
  assert.throws(() => validateProfileName('../escape'), /Invalid profile name/);
  assert.throws(() => validateProfileName('a/b'), /Invalid profile name/);
  assert.throws(() => validateProfileName(''), /Invalid profile name/);

  assert.equal(normalizeCliPath('/c/Users/dev/project', 'win32'), 'C:/Users/dev/project');
  assert.equal(normalizeCliPath('/d', 'win32'), 'D:/');
  assert.equal(normalizeCliPath('C:/Users/dev/project', 'win32'), 'C:/Users/dev/project');
  assert.equal(normalizeCliPath('/Users/dev/project', 'darwin'), '/Users/dev/project');
});

test('session, profile, and startup locks enforce exclusivity and recover stale dead-PID locks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-storage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));

  const lock1 = await acquireSessionLock(paths, 'sess-1');
  assert.equal(await isLockedByOther(paths.locksDir, 'session-sess-1', lock1.ownerId), false);
  assert.equal(await isLockedByOther(paths.locksDir, 'session-sess-1', 'other-owner'), true);
  await assert.rejects(acquireSessionLock(paths, 'sess-1'), { code: 'COPI_LOCKED' });

  await lock1.release();
  const lock2 = await acquireSessionLock(paths, 'sess-1');
  await lock2.release();

  // Stale lock from a non-existent PID is automatically reclaimed.
  await writeFile(join(paths.locksDir, 'profile-isolated.lock'), JSON.stringify({
    pid: 99999999,
    ownerId: 'dead-owner',
    kind: 'profile'
  }));
  const profLock = await acquireProfileLock(paths, 'isolated');
  await profLock.release();

  // Startup lock serializes concurrent callers without interleaving.
  const order = [];
  await Promise.all([
    withStartupLock(paths, async () => {
      order.push('a-start');
      await new Promise(resolve => setTimeout(resolve, 60));
      order.push('a-end');
    }),
    withStartupLock(paths, async () => {
      order.push('b-start');
      await new Promise(resolve => setTimeout(resolve, 60));
      order.push('b-end');
    })
  ]);
  const validAFirst = JSON.stringify(order) === JSON.stringify(['a-start', 'a-end', 'b-start', 'b-end']);
  const validBFirst = JSON.stringify(order) === JSON.stringify(['b-start', 'b-end', 'a-start', 'a-end']);
  assert.ok(validAFirst || validBFirst, `Expected serialized order without interleaving, got ${JSON.stringify(order)}`);

  // Acquire & release only removes own lock token.
  const l = await acquireLock(paths.locksDir, 'custom', { kind: 'test' });
  await l.release();
});

test('activity log and tool checkpoints record lifecycle events and detect interrupted tool calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-checkpoints-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));

  await logActivity(paths, 'session_start', { sessionId: 's1' });
  await logActivity(paths, 'send_retry', { sessionId: 's1', attempt: 1 });
  const lines = (await readFile(paths.activityLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.event), ['session_start', 'send_retry']);

  await recordToolCheckpoint(paths, { sessionId: 's1', toolCallId: 't1', toolName: 'bash', phase: 'started', args: { command: 'npm test' } });
  await recordToolCheckpoint(paths, { sessionId: 's1', toolCallId: 't1', toolName: 'bash', phase: 'completed', isError: false, durationMs: 40 });
  await recordToolCheckpoint(paths, { sessionId: 's1', toolCallId: 't2', toolName: 'write', phase: 'started', args: { path: 'a.txt' } });

  const incomplete = await readIncompleteCheckpoints(paths, 's1');
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].toolCallId, 't2');
  assert.equal(incomplete[0].toolName, 'write');
});
