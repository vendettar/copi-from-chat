import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const FALLBACK_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.venv', '.idea']);
const FALLBACK_MAX_DEPTH = 8;
const FALLBACK_MAX_FILES = 2000;
const FALLBACK_MAX_FILE_BYTES = 256 * 1024;

function isFilesystemRoot(dir) {
  const resolved = resolve(dir);
  return parse(resolved).root === resolved;
}

function globToRegex(pattern) {
  const escaped = String(pattern ?? '*')
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, ':::DOUBLE_STAR:::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/:::DOUBLE_STAR:::/g, '.*');
  return new RegExp(`^(?:.*/)?${escaped}$`);
}

function compileGitignoreRules(raw) {
  const rules = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const dirOnly = trimmed.endsWith('/');
    const clean = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) continue;
    rules.push({ dirOnly, regex: globToRegex(clean), prefix: `${clean}/` });
  }
  return rules;
}

async function walkNonGitFiles(rootDir, signal) {
  if (isFilesystemRoot(rootDir)) {
    throw new Error('Refusing to search a filesystem root. Select a project directory.');
  }
  const ignoreRaw = await readFile(resolve(rootDir, '.gitignore'), 'utf8').catch(() => '');
  const ignoreRules = compileGitignoreRules(ignoreRaw);
  const files = [];
  let truncated = false;

  const isIgnored = (relPath, isDir) => {
    for (const rule of ignoreRules) {
      if (rule.dirOnly && !isDir && !relPath.startsWith(rule.prefix)) continue;
      if (rule.regex.test(relPath) || relPath.startsWith(rule.prefix)) return true;
    }
    return false;
  };

  const walk = async (dir, depth) => {
    signal?.throwIfAborted();
    if (depth > FALLBACK_MAX_DEPTH || files.length >= FALLBACK_MAX_FILES) {
      truncated = true;
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (files.length >= FALLBACK_MAX_FILES) { truncated = true; return; }
      const full = resolve(dir, entry.name);
      const rel = relative(rootDir, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (FALLBACK_IGNORED_DIRS.has(entry.name) || isIgnored(rel, true)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (isIgnored(rel, false)) continue;
        files.push(rel);
      }
    }
  };

  await walk(rootDir, 0);
  return { files: files.sort(), truncated };
}

async function nonGitGrep({ target, directory, pattern, glob, literal, ignoreCase, context = 0, limit, signal }) {
  let regex;
  try {
    const flags = ignoreCase ? 'i' : '';
    const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    regex = new RegExp(source, flags);
  } catch (error) {
    throw new Error('Search failed. Check the search pattern syntax.', { cause: error });
  }

  let candidateFiles;
  let truncated = false;
  const baseDir = directory ? target : dirname(target);
  if (directory) {
    const walked = await walkNonGitFiles(target, signal);
    truncated = walked.truncated;
    const globRegex = glob ? globToRegex(glob) : null;
    candidateFiles = globRegex ? walked.files.filter(f => globRegex.test(f)) : walked.files;
  } else {
    candidateFiles = [basename(target)];
  }

  const ctxLines = Math.max(0, Math.min(5, Math.floor(Number(context) || 0)));
  const matches = [];
  for (const rel of candidateFiles) {
    signal?.throwIfAborted();
    if (matches.length >= limit + 1) { truncated = true; break; }
    const full = resolve(baseDir, rel);
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile() || info.size > FALLBACK_MAX_FILE_BYTES) continue;
    const raw = await readFile(full, 'utf8').catch(() => null);
    if (!raw || raw.includes('\0')) continue;
    const lines = raw.split(/\r?\n/);
    if (ctxLines === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}:${lines[i]}`);
          if (matches.length >= limit + 1) { truncated = true; break; }
        }
      }
      continue;
    }

    const hitSet = new Set();
    const ranges = [];
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;
      hitSet.add(i);
      const start = Math.max(0, i - ctxLines);
      const end = Math.min(lines.length - 1, i + ctxLines);
      if (ranges.length && start <= ranges.at(-1)[1] + 1) {
        ranges.at(-1)[1] = Math.max(ranges.at(-1)[1], end);
      } else {
        ranges.push([start, end]);
      }
    }
    for (let r = 0; r < ranges.length; r++) {
      if (matches.length >= limit + 1) { truncated = true; break; }
      if (r > 0 && matches.length) matches.push('--');
      const [start, end] = ranges[r];
      for (let i = start; i <= end; i++) {
        const sep = hitSet.has(i) ? ':' : '-';
        matches.push(`${rel}${sep}${i + 1}${sep}${lines[i]}`);
        if (matches.length >= limit + 1) { truncated = true; break; }
      }
    }
  }
  return formatResult(matches, limit, truncated, 'grep');
}

async function nonGitFind({ target, pattern, limit, signal }) {
  const walked = await walkNonGitFiles(target, signal);
  const matcher = globToRegex(pattern);
  const matched = walked.files.filter(file => matcher.test(file));
  return formatResult(matched, limit, walked.truncated, 'find');
}

function isNotGitRepoError(error) {
  const stderr = String(error?.cause?.stderr ?? error?.stderr ?? '');
  return /not a git repository/i.test(stderr);
}

async function git(cwd, args, signal, input) {
  signal?.throwIfAborted();
  try {
    const pending = exec('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, signal, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 512 * 1024
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    return { output: (await pending).stdout, truncated: false };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 1 && ['grep', 'check-ignore'].includes(args[0])) return { output: '', truncated: false };
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.message.startsWith('stdout')) {
      return { output: error.stdout, truncated: true };
    }
    if (error.code === 'ENOENT') throw new Error('Search is unavailable. Check the local installation.', { cause: error });
    if (error.killed) throw new Error('Search timed out. Narrow the search path or pattern.', { cause: error });
    throw new Error('Search failed. Check the pattern and select a directory inside a version-controlled project.', { cause: error });
  }
}

function records(result, separator) {
  const end = result.output.lastIndexOf(separator);
  const text = result.truncated ? result.output.slice(0, end + 1) : result.output;
  return text.split(separator).filter(Boolean).map(line => separator === '\n' ? line.replace(/\r$/, '') : line);
}

function formatResult(lines, limit, truncated, kind) {
  const selected = [];
  let size = 0, linesTruncated = false;
  for (const line of lines) {
    const clipped = kind === 'grep' && line.length > 500;
    const text = clipped ? Array.from(line).slice(0, 500).join('') + ' [line truncated; use read]' : line;
    const cost = JSON.stringify(text).length;
    if (selected.length >= limit || size + cost > 8000) { truncated = true; break; }
    linesTruncated ||= clipped;
    selected.push(text);
    size += cost;
  }
  let text = selected.join('\n') || (truncated ? 'No complete results within the output limit.' : 'No matches.');
  if (truncated || linesTruncated) text += '\n\n[Partial results. Narrow the pattern/path, then use read with offset/limit for file contents.]';
  return {
    content: [{ type: 'text', text }],
    details: kind === 'grep'
      ? { ...(truncated ? { matchLimitReached: selected.length } : {}), linesTruncated }
      : { ...(truncated ? { resultLimitReached: selected.length } : {}) }
  };
}

const pathParameter = { type: 'string', description: 'Search directory, relative to the project or absolute (default: .)' };
const limitParameter = { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum result lines (default: 50, maximum: 200)' };

export function createSearchTools(cwd, { allowNonGitFallback = false } = {}) {
  return [
    {
      name: 'grep', label: 'grep',
      description: 'Search file contents. Returns path:line:content relative to path. Pass context (1-5) to include surrounding lines directly without an extra read.',
      promptSnippet: 'Search file contents',
      promptGuidelines: ['Use grep for content searches; pass context (e.g. 2-4) when you need surrounding lines to edit without an extra read turn.'],
      parameters: { type: 'object', required: ['pattern'], additionalProperties: false, properties: {
        pattern: { type: 'string', minLength: 1, description: 'Text to find; extended regular expression when literal=false' },
        path: { ...pathParameter, description: 'Directory or file to search, relative to the project or absolute (default: .)' },
        glob: { type: 'string', description: 'Filename wildcard, e.g. *.js (directory searches only)' },
        literal: { type: 'boolean', description: 'Literal matching (default: true); false uses extended regex' },
        ignoreCase: { type: 'boolean', description: 'Ignore letter case (default: false)' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: 'Context lines before/after each match (0-5, default: 0)' },
        limit: limitParameter
      } },
      async execute(_id, { pattern, path = '.', glob, literal = true, ignoreCase = false, context = 0, limit = 50 }, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const target = resolve(ctx?.cwd || cwd, path), directory = (await stat(target)).isDirectory();
        if (!directory && glob) throw new Error('Use glob with a directory path, or search the file without glob.');
        const ctxLines = Math.max(0, Math.min(5, Math.floor(Number(context) || 0)));
        const args = ['grep', '--untracked', '--exclude-standard', '-n', '-I', '--no-color', '--no-heading', '--no-break', '--no-column', literal ? '-F' : '-E'];
        if (ignoreCase) args.push('-i');
        if (ctxLines > 0) args.push('-C', String(ctxLines));
        args.push('-e', pattern, '--', directory ? (glob || '.') : `:(literal)${basename(target)}`);
        try {
          const result = await git(directory ? target : dirname(target), args, signal);
          return formatResult(records(result, '\n'), limit, result.truncated, 'grep');
        } catch (error) {
          if (allowNonGitFallback && isNotGitRepoError(error)) {
            return nonGitGrep({ target, directory, pattern, glob, literal, ignoreCase, context: ctxLines, limit, signal });
          }
          throw error;
        }
      }
    },
    {
      name: 'find', label: 'find',
      description: 'Find files by filename pattern. Returns paths relative to path. Narrow the scope if results are partial.',
      promptSnippet: 'Find files by filename pattern',
      promptGuidelines: ['Use the find tool to discover files. Narrow path or pattern when results are partial.'],
      parameters: { type: 'object', required: ['pattern'], additionalProperties: false, properties: {
        pattern: { type: 'string', minLength: 1, description: 'Filename wildcard, e.g. *.ts, src/**, or * for all files' },
        path: pathParameter, limit: limitParameter
      } },
      async execute(_id, { pattern, path = '.', limit = 50 }, signal, _onUpdate, ctx) {
        const target = resolve(ctx?.cwd || cwd, path);
        try {
          const result = await git(target, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', pattern], signal);
          const files = [...new Set(records(result, '\0'))];
          const ignored = files.length ? await git(target, ['check-ignore', '--no-index', '-z', '--stdin'], signal, files.join('\0') + '\0') : { output: '' };
          if (ignored.truncated) throw new Error('Search is too broad. Narrow the path or pattern.');
          const excluded = new Set(records(ignored, '\0'));
          return formatResult(files.filter(file => !excluded.has(file)), limit, result.truncated, 'find');
        } catch (error) {
          if (allowNonGitFallback && isNotGitRepoError(error)) {
            return nonGitFind({ target, pattern, limit, signal });
          }
          throw error;
        }
      }
    }
  ];
}
