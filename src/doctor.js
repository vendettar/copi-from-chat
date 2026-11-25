import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getBrowserHostHealth } from './browser-client.js';
import { getCopiPaths } from './paths.js';
import { formatQuotaShort, readTodayQuota } from './quota.js';
import { resolveShellPath } from './runtime.js';
import { inspectLock } from './storage.js';

const exec = promisify(execFile);
const CLI_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
})();

function exists(filePath) {
  try { accessSync(filePath, constants.F_OK); return true; } catch { return false; }
}

function findEdgeExecutable(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const candidates = [
    env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    env.ProgramFiles ? join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''
  ].filter(Boolean);
  return candidates.find(exists) ?? null;
}

export async function runDoctor({ paths = getCopiPaths(), browser } = {}) {
  const checks = [];

  // 1. Node.js version
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: major >= 20,
    detail: `v${process.versions.node}${major < 20 ? ' (requires >=20)' : ''}`
  });

  // 2. Git availability
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true, timeout: 4000 });
    checks.push({ name: 'Git', ok: true, detail: stdout.trim() });
  } catch {
    checks.push({ name: 'Git', ok: false, detail: 'git not found on PATH' });
  }

  // 3. Shell / Git Bash
  const shell = resolveShellPath();
  checks.push({
    name: 'Bash shell',
    ok: process.platform !== 'win32' || Boolean(shell),
    detail: shell ?? (process.platform === 'win32' ? 'will fall back to bash.exe on PATH' : 'POSIX /bin/bash')
  });

  // 4. Microsoft Edge (Windows)
  if (process.platform === 'win32') {
    const edge = findEdgeExecutable();
    checks.push({ name: 'Microsoft Edge', ok: Boolean(edge), detail: edge ?? 'msedge.exe not found in standard paths' });
  }

  // 5. Locks under ~/.copi/locks
  let activeLocks = 0;
  try {
    const lockFiles = (await readdir(paths.locksDir)).filter(f => f.endsWith('.lock'));
    for (const file of lockFiles) {
      const key = file.replace(/\.lock$/, '');
      if (await inspectLock(paths.locksDir, key)) activeLocks++;
    }
    checks.push({ name: 'Local locks', ok: true, detail: `${activeLocks} active lock(s) in ${paths.locksDir}` });
  } catch {
    checks.push({ name: 'Local locks', ok: true, detail: 'no lock directory yet' });
  }

  // 6. Browser Host health & version alignment
  const host = await getBrowserHostHealth(paths);
  const hostVersion = host.health?.version ?? host.descriptor?.version ?? null;
  const versionMismatch = Boolean(host.running && CLI_VERSION && hostVersion && hostVersion !== CLI_VERSION);
  checks.push({
    name: 'Browser Host',
    ok: host.running && !versionMismatch,
    warn: !host.running || versionMismatch,
    detail: host.running
      ? (versionMismatch
        ? `running older v${hostVersion} (CLI is v${CLI_VERSION}) on 127.0.0.1:${host.descriptor.port} — run "copi host stop" to apply updates`
        : `running v${hostVersion ?? '?'} on 127.0.0.1:${host.descriptor.port} (PID ${host.descriptor.pid}, ${host.health.tabs?.length ?? 0} tab(s))`)
      : host.stale ? 'not running (stale browser-host.json)' : 'not running (starts automatically with copi)'
  });

  // 7. Live M365 DOM selector health (when a live browser tab is open)
  if (typeof browser?.inspectDomHealth === 'function') {
    const dom = await browser.inspectDomHealth().catch(() => null);
    if (dom?.pageOpen) {
      const domOk = dom.composerCount === 1 && dom.sendButtonVisible;
      checks.push({
        name: 'M365 DOM selectors',
        ok: domOk,
        detail: `composer=${dom.composerCount}, send=${dom.sendButtonVisible}, modelPicker=${dom.pickerFound}, replies=${dom.replyCount}`
      });
    } else {
      checks.push({ name: 'M365 DOM selectors', ok: true, warn: true, detail: 'no Edge tab open yet' });
    }
  }

  // 8. Daily quota summary
  const quota = await readTodayQuota(paths);
  checks.push({
    name: 'Daily turns',
    ok: !quota.thinkLimited,
    warn: quota.thinkLimited,
    detail: `${formatQuotaShort(quota)} (${quota.date})`
  });

  const lines = checks.map(c => {
    const tag = c.ok ? (c.warn ? '[INFO]' : '[PASS]') : (c.warn ? '[WARN]' : '[FAIL]');
    return `${tag} ${c.name}: ${c.detail}`;
  });
  return {
    ok: checks.every(c => c.ok || c.warn),
    checks,
    text: lines.join('\n')
  };
}
