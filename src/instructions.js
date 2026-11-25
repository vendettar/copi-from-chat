import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  join('.copi', 'instructions.md')
];

const DEFAULT_MAX_CHARS = 16000;

export async function loadProjectInstructions(cwd, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!cwd) return { files: [], promptSection: '' };
  const loaded = [];
  let used = 0;

  for (const relPath of PROJECT_INSTRUCTION_FILES) {
    const fullPath = join(cwd, relPath);
    let raw;
    try {
      raw = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const label = relPath.replaceAll('\\', '/');
    const content = trimmed.length > remaining
      ? `${trimmed.slice(0, remaining)}\n\n[Truncated ${label} after ${remaining} characters]`
      : trimmed;
    loaded.push({ file: label, content });
    used += content.length;
  }

  if (!loaded.length) return { files: [], promptSection: '' };

  const promptSection = [
    'Project instructions loaded from workspace:',
    ...loaded.map(({ file, content }) => `--- ${file} ---\n${content}`)
  ].join('\n\n');

  return {
    files: loaded.map(item => item.file),
    promptSection
  };
}
