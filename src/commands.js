import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { denoiseToolOutput } from './tool-output.js';

const exec = promisify(execFile);
const MAX_LOCAL_RUN_PROMPT_CHARS = 3500;
const MAX_LOCAL_RUN_DISPLAY_CHARS = 8000;

export function extractLastCodeBlock(markdown) {
  if (typeof markdown !== 'string') return null;
  const matches = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  return matches.at(-1)[1].replace(/\n$/, '');
}

function runClipboardPipe(command, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}

export async function copyToClipboard(text, platform = process.platform) {
  if (typeof text !== 'string' || !text) {
    throw new Error('Nothing to copy.');
  }
  if (platform === 'win32') {
    // PowerShell Set-Clipboard preserves UTF-8 (Chinese/emoji) cleanly unlike clip.exe's legacy ANSI codepage.
    try {
      await runClipboardPipe('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'
      ], text);
      return;
    } catch {
      await runClipboardPipe('clip.exe', [], text);
      return;
    }
  }
  if (platform === 'darwin') {
    await runClipboardPipe('pbcopy', [], text);
    return;
  }
  for (const [cmd, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]) {
    try {
      await runClipboardPipe(cmd, args, text);
      return;
    } catch { /* try next */ }
  }
  throw new Error('No clipboard utility found (tried wl-copy, xclip, xsel).');
}

export async function getGitDiffSummary(cwd) {
  try {
    const [statusRes, statRes, cachedRes] = await Promise.all([
      exec('git', ['-c', 'core.quotepath=false', 'status', '-s'], { cwd, windowsHide: true, timeout: 10000 }),
      exec('git', ['-c', 'core.quotepath=false', 'diff', '--stat'], { cwd, windowsHide: true, timeout: 10000 }),
      exec('git', ['-c', 'core.quotepath=false', 'diff', '--cached', '--stat'], { cwd, windowsHide: true, timeout: 10000 })
    ]);
    const status = statusRes.stdout.trim();
    const unstaged = statRes.stdout.trim();
    const staged = cachedRes.stdout.trim();
    if (!status && !unstaged && !staged) {
      return { isGit: true, clean: true, text: 'Working tree is clean (no uncommitted changes).' };
    }
    const sections = [];
    if (status) sections.push(`Status:\n${status}`);
    if (staged) sections.push(`Staged diff:\n${staged}`);
    if (unstaged) sections.push(`Unstaged diff:\n${unstaged}`);
    return { isGit: true, clean: false, text: sections.join('\n\n') };
  } catch (error) {
    return {
      isGit: false,
      clean: false,
      text: `Git diff unavailable: ${error?.stderr?.trim() || error?.message || 'not a git repository'}`
    };
  }
}

export async function cleanupLocalArtifacts({
  paths,
  maxAgeDays = 14,
  activeSessionId = null,
  tempDir = tmpdir(),
  now = Date.now()
} = {}) {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  let removedFiles = 0;
  let freedBytes = 0;

  // 1. Prune old tool checkpoints (never deleting the active session's checkpoint file).
  if (paths?.checkpointsDir) {
    try {
      const files = await readdir(paths.checkpointsDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        if (activeSessionId && file === `${activeSessionId}.jsonl`) continue;
        const full = join(paths.checkpointsDir, file);
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs <= cutoff) {
          await unlink(full).catch(() => {});
          removedFiles++;
          freedBytes += info.size;
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Prune old saved tool-output temp files (copi-output-*.txt / copilot-output-*.txt).
  try {
    const tempFiles = await readdir(tempDir);
    for (const file of tempFiles) {
      if (!/^(?:copi|copilot)-output-.*\.txt$/.test(file)) continue;
      const full = join(tempDir, file);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs <= cutoff) {
        await unlink(full).catch(() => {});
        removedFiles++;
        freedBytes += info.size;
      }
    }
  } catch { /* ignore */ }

  return { removedFiles, freedBytes, maxAgeDays };
}

function clipTextHeadTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - maxChars} chars omitted ...]\n\n${text.slice(-tail)}`;
}

// Run a shell command locally at 0 web quota so users can inspect output or feed a failure
// directly into their next prompt without burning a Copilot bash turn.
export function runLocalCommand(command, { cwd, shellPath, timeoutMs = 30000 } = {}) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return Promise.reject(new Error('Command cannot be empty.'));
  const bin = shellPath || (process.platform === 'win32' ? 'bash.exe' : '/bin/bash');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, ['-lc', cmd], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 256 * 1024;
    let timedOut = false;
    const onData = chunk => {
      if (totalBytes >= maxBytes) return;
      const slice = totalBytes + chunk.length > maxBytes ? chunk.subarray(0, maxBytes - totalBytes) : chunk;
      chunks.push(slice);
      totalBytes += slice.length;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    child.on('error', error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const denoised = denoiseToolOutput(raw).trim();
      const exitCode = timedOut ? 124 : (code ?? 0);
      const body = timedOut
        ? `${denoised ? `${denoised}\n` : ''}[command timed out after ${Math.round(timeoutMs / 1000)}s]`
        : (denoised || '(no output)');
      const displayOutput = clipTextHeadTail(body, MAX_LOCAL_RUN_DISPLAY_CHARS);
      const promptOutput = clipTextHeadTail(body, MAX_LOCAL_RUN_PROMPT_CHARS);
      const promptBlock = `[Local /run output — already executed locally, no need to re-run]\nCommand: ${cmd}\nExit code: ${exitCode}\nOutput:\n${promptOutput}`;
      resolveRun({
        command: cmd,
        exitCode,
        timedOut,
        output: displayOutput,
        promptBlock
      });
    });
  });
}

// Persist a project coding preference/rule into <cwd>/.copi/instructions.md at 0 web quota.
export async function appendProjectRule(cwd, rule) {
  const cleaned = String(rule ?? '').trim();
  if (!cleaned) throw new Error('Rule text cannot be empty.');
  const dir = join(cwd, '.copi');
  const filePath = join(dir, 'instructions.md');
  await mkdir(dir, { recursive: true });
  const existing = await readFile(filePath, 'utf8').catch(() => '');
  const prefix = existing.trim() ? `${existing.trimEnd()}\n` : '# Project Instructions for Copi\n\n';
  const bullet = cleaned.startsWith('- ') ? cleaned : `- ${cleaned}`;
  await writeFile(filePath, `${prefix}${bullet}\n`, 'utf8');
  return { path: filePath.replaceAll('\\', '/'), bullet };
}

export async function readProjectRules(cwd) {
  const filePath = join(cwd, '.copi', 'instructions.md');
  const content = await readFile(filePath, 'utf8').catch(() => '');
  return { path: filePath.replaceAll('\\', '/'), content: content.trim() };
}

export async function formatRecentActivity(paths, limit = 20) {
  if (!paths?.activityLog) return 'Activity log path unavailable.';
  const raw = await readFile(paths.activityLog, 'utf8').catch(() => '');
  if (!raw.trim()) return 'No activity logged yet.';
  const count = Math.max(1, Math.min(100, Number(limit) || 20));
  const lines = raw.trim().split(/\r?\n/).slice(-count);
  const formatted = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const stamp = typeof entry.ts === 'string' ? entry.ts.replace('T', ' ').slice(5, 19) : '??';
      const { ts: _ts, pid: _pid, event, ...rest } = entry;
      const details = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 80) : JSON.stringify(v).slice(0, 80);
          return `${k}=${val}`;
        })
        .join(' ');
      formatted.push(`${stamp}  ${String(event ?? 'event').padEnd(24)} ${details}`.trimEnd());
    } catch {
      formatted.push(line.slice(0, 120));
    }
  }
  return formatted.join('\n');
}
