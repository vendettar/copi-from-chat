import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VALID_CMD_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const BUILTIN_PROMPTS = new Map([
  ['review', {
    name: 'review',
    source: 'builtin',
    description: 'Code review current git changes (preloads git diff locally, 0 extra turns)',
    body: `Review the current workspace changes for bugs, edge cases, regressions, and security issues. Be concise and actionable. {{args}}

Current branch: {{branch}}

Git diff:
\`\`\`diff
{{diff}}
\`\`\``
  }],
  ['commit', {
    name: 'commit',
    source: 'builtin',
    description: 'Draft a clear conventional commit message from current git diff',
    body: `Generate a concise conventional commit message (title + short bullet body if needed) based ONLY on the git diff below. Do not run git commit unless asked. {{args}}

Current branch: {{branch}}

Git diff:
\`\`\`diff
{{diff}}
\`\`\``
  }],
  ['fix', {
    name: 'fix',
    source: 'builtin',
    description: 'Diagnose and fix an issue or failing test in minimum turns',
    body: `Diagnose and fix the following issue in this project, batching file reads and verification checks to minimize turns: {{args}}`
  }]
]);

async function loadDirPrompts(dir, source) {
  const loaded = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return loaded; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = basename(entry.name, '.md').toLowerCase();
    if (!VALID_CMD_NAME.test(name)) continue;
    const raw = (await readFile(join(dir, entry.name), 'utf8').catch(() => '')).trim();
    if (!raw) continue;
    const firstLine = raw.split(/\r?\n/)[0].replace(/^#+\s*/, '').trim();
    loaded.push({
      name,
      source,
      description: firstLine.slice(0, 80) || `Custom prompt (${source})`,
      body: raw
    });
  }
  return loaded;
}

export async function loadPromptTemplates({ copiPaths, cwd, reservedNames = new Set() } = {}) {
  const map = new Map();
  for (const [name, template] of BUILTIN_PROMPTS) {
    if (!reservedNames.has(name)) map.set(name, template);
  }
  if (copiPaths?.promptsDir) {
    for (const tpl of await loadDirPrompts(copiPaths.promptsDir, 'global')) {
      if (!reservedNames.has(tpl.name)) map.set(tpl.name, tpl);
    }
  }
  if (cwd) {
    for (const tpl of await loadDirPrompts(join(cwd, '.copi', 'prompts'), 'project')) {
      if (!reservedNames.has(tpl.name)) map.set(tpl.name, tpl);
    }
  }
  return [...map.values()];
}

export async function renderPromptTemplate(template, { args = '', cwd } = {}) {
  let body = template.body;
  body = body.replaceAll('{{args}}', args.trim());
  body = body.replaceAll('{{cwd}}', (cwd ?? '').replaceAll('\\', '/'));

  if (body.includes('{{branch}}')) {
    let branch = '(unknown)';
    try {
      const res = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, windowsHide: true, timeout: 4000 });
      branch = res.stdout.trim() || branch;
    } catch { /* ignore */ }
    body = body.replaceAll('{{branch}}', branch);
  }

  if (body.includes('{{diff}}')) {
    let diff = '';
    try {
      const [staged, unstaged] = await Promise.all([
        exec('git', ['-c', 'core.quotepath=false', 'diff', '--cached'], { cwd, windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 }),
        exec('git', ['-c', 'core.quotepath=false', 'diff'], { cwd, windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 })
      ]);
      diff = [staged.stdout.trim(), unstaged.stdout.trim()].filter(Boolean).join('\n\n');
    } catch { /* ignore */ }
    if (!diff) diff = '(no uncommitted git diff)';
    else if (diff.length > 10000) diff = `${diff.slice(0, 10000)}\n... [diff truncated at 10,000 chars]`;
    body = body.replaceAll('{{diff}}', diff);
  }

  return body.trim();
}
