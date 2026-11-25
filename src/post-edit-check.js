import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);

// Zero-quota local syntax verification right after write/edit so syntax typos are caught
// immediately inside the same toolResult without burning an extra bash turn.
export async function runPostEditSyntaxCheck(targetPath, cwd) {
  if (!targetPath || !cwd) return null;
  const full = resolve(cwd, targetPath);
  const ext = extname(full).toLowerCase();

  if (ext === '.json') {
    try {
      const raw = await readFile(full, 'utf8');
      JSON.parse(raw);
      return { ok: true, note: '[local syntax check] valid JSON' };
    } catch (error) {
      return { ok: false, note: `[local syntax check] JSON SYNTAX ERROR: ${error.message}` };
    }
  }

  if (JS_EXTS.has(ext)) {
    try {
      await exec(process.execPath, ['--check', full], { cwd, windowsHide: true, timeout: 5000 });
      return { ok: true, note: '[local syntax check] node --check passed' };
    } catch (error) {
      const detail = (error.stderr || error.message || 'syntax error').trim().split(/\r?\n/).slice(0, 6).join('\n');
      return { ok: false, note: `[local syntax check] JS SYNTAX ERROR:\n${detail}` };
    }
  }

  return null;
}
