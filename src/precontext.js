import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeCliPath } from './paths.js';

const exec = promisify(execFile);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.venv']);
const SKIP_PRELOAD_EXTS = new Set([
  '.jar', '.war', '.ear', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.class',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi',
  '.sqlite', '.db', '.pyc', '.pyo'
]);
const SKIP_AUTO_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock']);
const MAX_SNAPSHOT_FILES = 75;
const MAX_SNAPSHOT_CHARS = 3500;
const MAX_PRELOAD_FILES = 4;
const MAX_PRELOAD_FILE_CHARS = 4000;
const MAX_PRELOAD_TOTAL_CHARS = 10000;
const MAX_AUTO_PRELOAD_FILES = 2;
const MAX_AUTO_PRELOAD_FILE_CHARS = 2500;
const MAX_AUTO_PRELOAD_TOTAL_CHARS = 4000;

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

// Match @path/to/file (relative, Windows drive, or POSIX absolute) preceded by whitespace/CJK/punctuation (never emails).
const FILE_MENTION = /(?:^|[\s([{"'`，。！？、；：（）《》【】])@((?:[A-Za-z]:[\\/]|[\\/])?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9_-]+)(?::(\d+)(?:-(\d+))?)?/g;
// Match plain relative workspace paths OR absolute paths (only loaded if inside cwd or allowedDirs).
const PLAIN_FILE_PATH = /(?<![A-Za-z0-9_@:/\\.-])((?:[A-Za-z]:[\\/]|\.[\\/]|\/)?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{1,12})(?::(\d+)(?:-(\d+))?)?(?![A-Za-z0-9_/.:-])/g;

function hasIgnoredSegment(relPath) {
  return relPath.split('/').some(seg => IGNORED_DIRS.has(seg));
}

function isInsideDir(dir, target) {
  const rel = relative(dir, target);
  if (!rel) return true;
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}

export async function expandFileMentions(prompt, cwd, {
  allowedDirs = [],
  maxFiles = MAX_PRELOAD_FILES,
  maxFileChars = MAX_PRELOAD_FILE_CHARS,
  maxTotalChars = MAX_PRELOAD_TOTAL_CHARS,
  includePlainPaths = true,
  maxAutoFiles = MAX_AUTO_PRELOAD_FILES,
  maxAutoFileChars = MAX_AUTO_PRELOAD_FILE_CHARS,
  maxAutoTotalChars = MAX_AUTO_PRELOAD_TOTAL_CHARS
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || !cwd) {
    return { text: prompt, loadedFiles: [], loadedEntries: [] };
  }
  // Fast exit for plain prose with no @ mentions and no filename.ext tokens.
  if (!prompt.includes('@') && !/[A-Za-z0-9_-]\.[A-Za-z0-9_-]{1,12}\b/.test(prompt)) {
    return { text: prompt, loadedFiles: [], loadedEntries: [] };
  }

  const root = resolve(cwd);
  const authorizedExtras = Array.isArray(allowedDirs)
    ? allowedDirs.filter(d => typeof d === 'string' && d.trim()).map(d => resolve(root, normalizeCliPath(d)))
    : [];
  const seenKeys = new Set();
  const seenFiles = new Set();
  const blocks = [];
  const loadedFiles = [];
  const loadedEntries = [];
  let totalChars = 0;
  let autoCount = 0;
  let autoChars = 0;

  const tryLoad = async (rawPath, startStr, endStr, { explicit }) => {
    if (blocks.length >= maxFiles || totalChars >= maxTotalChars) return;
    if (!explicit && (autoCount >= maxAutoFiles || autoChars >= maxAutoTotalChars)) return;

    const rawRel = normalizeCliPath(rawPath).replaceAll('\\', '/');
    const startLine = startStr ? Math.max(1, Number(startStr)) : null;
    const endLine = endStr ? Math.max(startLine ?? 1, Number(endStr)) : null;
    const target = resolve(root, rawRel);
    const inRoot = isInsideDir(root, target);
    const matchedExtra = !inRoot ? authorizedExtras.find(dir => isInsideDir(dir, target)) : null;
    if (!inRoot && !matchedExtra) return;
    const rel = inRoot ? relative(root, target) : null;
    if (inRoot && !rel) return;

    const displayPath = inRoot ? rel.replaceAll('\\', '/') : target.replaceAll('\\', '/');
    const lowerBase = displayPath.split('/').at(-1)?.toLowerCase() ?? '';
    const dotIdx = lowerBase.lastIndexOf('.');
    const ext = dotIdx >= 0 ? lowerBase.slice(dotIdx) : '';
    if (SKIP_PRELOAD_EXTS.has(ext)) return;
    const relForIgnore = inRoot ? displayPath : relative(matchedExtra, target).replaceAll('\\', '/');
    if (!explicit && (hasIgnoredSegment(relForIgnore) || SKIP_AUTO_FILENAMES.has(lowerBase))) return;

    const key = `${displayPath}:${startLine ?? ''}:${endLine ?? ''}`;
    if (seenKeys.has(key)) return;
    // If an explicit @file already loaded this file (even a line range), don't auto-preload it again.
    if (!explicit && seenFiles.has(displayPath)) return;

    const info = await stat(target).catch(() => null);
    const maxBytes = explicit ? 512 * 1024 : 256 * 1024;
    if (!info || !info.isFile() || info.size > maxBytes) return;

    let raw;
    try { raw = await readFile(target, 'utf8'); } catch { return; }
    if (raw.includes('\0')) return; // Skip binary files.

    let snippet = raw;
    let rangeLabel = '';
    let effectiveEnd = null;
    if (startLine !== null) {
      const lines = raw.split(/\r?\n/);
      effectiveEnd = Math.min(lines.length, endLine ?? Math.min(lines.length, startLine + 120));
      snippet = lines.slice(startLine - 1, effectiveEnd).map((line, i) => `${startLine + i}: ${line}`).join('\n');
      rangeLabel = ` (lines ${startLine}-${effectiveEnd})`;
    }

    const perFileLimit = explicit ? maxFileChars : maxAutoFileChars;
    const remainingTotal = maxTotalChars - totalChars;
    const remainingAuto = explicit ? remainingTotal : (maxAutoTotalChars - autoChars);
    const budget = Math.min(perFileLimit, remainingTotal, remainingAuto);
    if (budget < 128) return;

    let truncated = false;
    if (snippet.length > budget) {
      snippet = `${snippet.slice(0, budget)}\n... [truncated; use read with offset/limit for more]`;
      truncated = true;
    }

    seenKeys.add(key);
    seenFiles.add(displayPath);
    loadedFiles.push(`${displayPath}${rangeLabel}`);
    loadedEntries.push({
      path: displayPath,
      startLine,
      endLine: effectiveEnd,
      content: startLine === null ? raw : raw.split(/\r?\n/).slice(startLine - 1, effectiveEnd).join('\n'),
      truncated,
      explicit
    });
    const prefix = explicit ? '@' : '';
    blocks.push(`--- ${prefix}${displayPath}${rangeLabel} ---\n${snippet}`);
    totalChars += snippet.length;
    if (!explicit) {
      autoCount++;
      autoChars += snippet.length;
    }
  };

  // Pass 1: explicit @path/to/file mentions (higher priority & budget).
  if (prompt.includes('@')) {
    for (const match of prompt.matchAll(FILE_MENTION)) {
      await tryLoad(match[1], match[2], match[3], { explicit: true });
    }
  }

  // Pass 2: natural plain workspace paths (no @ required) verified on disk.
  if (includePlainPaths) {
    for (const match of prompt.matchAll(PLAIN_FILE_PATH)) {
      await tryLoad(match[1], match[2], match[3], { explicit: false });
    }
  }

  if (!blocks.length) return { text: prompt, loadedFiles: [], loadedEntries: [] };
  return {
    text: `${prompt}\n\n[Preloaded file context — already read locally, no need to re-read these sections]\n${blocks.join('\n\n')}`,
    loadedFiles,
    loadedEntries
  };
}
