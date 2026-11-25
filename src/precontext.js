import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.venv']);
const MAX_SNAPSHOT_FILES = 75;
const MAX_SNAPSHOT_CHARS = 3500;
const MAX_PRELOAD_FILES = 4;
const MAX_PRELOAD_FILE_CHARS = 4000;
const MAX_PRELOAD_TOTAL_CHARS = 10000;

async function listWorkspaceFiles(cwd, limit = MAX_SNAPSHOT_FILES) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd, windowsHide: true, timeout: 4000, maxBuffer: 256 * 1024
    });
    const all = stdout.split(/\r?\n/).filter(Boolean);
    return { files: all.slice(0, limit), total: all.length, truncated: all.length > limit };
  } catch {
    // Bounded non-Git fallback for quick directory overview.
    const files = [];
    let truncated = false;
    const walk = async (dir, depth) => {
      if (depth > 3 || files.length >= limit) { truncated = true; return; }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (files.length >= limit) { truncated = true; return; }
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          files.push(relative(cwd, join(dir, entry.name)).replaceAll('\\', '/'));
        }
      }
    };
    await walk(cwd, 0);
    return { files: files.sort(), total: files.length, truncated };
  }
}

async function readManifestSummary(cwd) {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const scripts = Object.keys(pkg.scripts ?? {});
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    return [
      `package.json: ${pkg.name ?? '(unnamed)'}@${pkg.version ?? '0.0.0'}`,
      scripts.length ? `scripts: ${scripts.join(', ')}` : '',
      deps.length ? `deps: ${deps.slice(0, 15).join(', ')}` : '',
      devDeps.length ? `devDeps: ${devDeps.slice(0, 10).join(', ')}` : ''
    ].filter(Boolean).join(' | ');
  } catch { /* not a node package */ }

  for (const name of ['pyproject.toml', 'Cargo.toml', 'go.mod']) {
    try {
      const raw = await readFile(join(cwd, name), 'utf8');
      const head = raw.split(/\r?\n/).slice(0, 12).join('\n').trim();
      if (head) return `${name}:\n${head}`;
    } catch { /* ignore */ }
  }
  return '';
}

export async function collectWorkspaceSnapshot(cwd, { maxChars = MAX_SNAPSHOT_CHARS } = {}) {
  if (!cwd) return '';
  const parts = [];

  try {
    const [branchRes, statusRes] = await Promise.all([
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, windowsHide: true, timeout: 3000 }),
      exec('git', ['-c', 'core.quotepath=false', 'status', '-s'], { cwd, windowsHide: true, timeout: 3000 })
    ]);
    const branch = branchRes.stdout.trim();
    const statusLines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
    if (branch) parts.push(`Branch: ${branch}`);
    if (statusLines.length) {
      const shown = statusLines.slice(0, 20).join('\n');
      parts.push(`Git status (${statusLines.length} changed):\n${shown}${statusLines.length > 20 ? '\n...' : ''}`);
    } else {
      parts.push('Git status: clean');
    }
  } catch { /* not a git repo */ }

  const manifest = await readManifestSummary(cwd);
  if (manifest) parts.push(manifest);

  const listing = await listWorkspaceFiles(cwd);
  if (listing.files.length) {
    const note = listing.truncated ? ` (showing ${listing.files.length}/${listing.total})` : ` (${listing.files.length})`;
    parts.push(`Files${note}:\n${listing.files.join('\n')}`);
  }

  if (!parts.length) return '';
  const full = `[Preloaded workspace snapshot — use this directly to avoid extra discovery turns]\n${parts.join('\n\n')}`;
  return full.length <= maxChars ? full : `${full.slice(0, maxChars)}\n... [snapshot truncated]`;
}

// Match @path/to/file or @path/to/file:10-80 preceded by start-of-string or whitespace (never emails).
const FILE_MENTION = /(?:^|[\s(])@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_-]+)(?::(\d+)(?:-(\d+))?)?/g;

export async function expandFileMentions(prompt, cwd, {
  maxFiles = MAX_PRELOAD_FILES,
  maxFileChars = MAX_PRELOAD_FILE_CHARS,
  maxTotalChars = MAX_PRELOAD_TOTAL_CHARS
} = {}) {
  if (typeof prompt !== 'string' || !prompt.includes('@') || !cwd) {
    return { text: prompt, loadedFiles: [] };
  }

  const root = resolve(cwd);
  const seen = new Set();
  const blocks = [];
  const loadedFiles = [];
  let totalChars = 0;

  for (const match of prompt.matchAll(FILE_MENTION)) {
    if (blocks.length >= maxFiles || totalChars >= maxTotalChars) break;
    const rawRel = match[1].replaceAll('\\', '/');
    const startLine = match[2] ? Math.max(1, Number(match[2])) : null;
    const endLine = match[3] ? Math.max(startLine ?? 1, Number(match[3])) : null;
    const target = resolve(root, rawRel);
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const key = `${rel}:${startLine ?? ''}:${endLine ?? ''}`;
    if (seen.has(key)) continue;

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile() || info.size > 512 * 1024) continue;

    let raw;
    try { raw = await readFile(target, 'utf8'); } catch { continue; }
    if (raw.includes('\0')) continue; // Skip binary files.

    let snippet = raw;
    let rangeLabel = '';
    if (startLine !== null) {
      const lines = raw.split(/\r?\n/);
      const to = endLine ?? Math.min(lines.length, startLine + 120);
      snippet = lines.slice(startLine - 1, to).map((line, i) => `${startLine + i}: ${line}`).join('\n');
      rangeLabel = ` (lines ${startLine}-${Math.min(lines.length, to)})`;
    }

    const budget = Math.min(maxFileChars, maxTotalChars - totalChars);
    if (budget < 128) break;
    if (snippet.length > budget) {
      snippet = `${snippet.slice(0, budget)}\n... [truncated; use read with offset/limit for more]`;
    }
    seen.add(key);
    const displayPath = rel.replaceAll('\\', '/');
    loadedFiles.push(`${displayPath}${rangeLabel}`);
    blocks.push(`--- @${displayPath}${rangeLabel} ---\n${snippet}`);
    totalChars += snippet.length;
  }

  if (!blocks.length) return { text: prompt, loadedFiles: [] };
  return {
    text: `${prompt}\n\n[Preloaded @file context — already read locally, no need to re-read these sections]\n${blocks.join('\n\n')}`,
    loadedFiles
  };
}
