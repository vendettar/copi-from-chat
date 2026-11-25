import { execFile, spawn } from 'node:child_process';
import { readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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
