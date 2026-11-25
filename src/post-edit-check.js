import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTS = new Set(['.ts', '.mts', '.cts']);
const MAX_HINT_FILE_BYTES = 512 * 1024;
const MAX_HINT_CHARS = 2400;

function supportsNodeStripTypes() {
  const [major, minor] = String(process.versions?.node ?? '0.0').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

const TS_CHECK_SCRIPT = 'import { readFileSync } from "node:fs"; import { stripTypeScriptTypes } from "node:module"; if (typeof stripTypeScriptTypes !== "function") process.exit(42); stripTypeScriptTypes(readFileSync(process.argv[1], "utf8"));';

async function runPythonAstCheck(fullPath, cwd) {
  const candidates = process.platform === 'win32'
    ? [['python', ['-B']], ['py', ['-3', '-B']]]
    : [['python3', ['-B']], ['python', ['-B']]];
  const code = 'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), filename=sys.argv[1])';

  for (const [bin, prefix] of candidates) {
    try {
      await exec(bin, [...prefix, '-c', code, fullPath], { cwd, windowsHide: true, timeout: 5000 });
      return { ok: true, note: '[local syntax check] python ast.parse passed' };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      const detail = (error.stderr || error.message || 'syntax error').trim().split(/\r?\n/).slice(-5).join('\n');
      return { ok: false, note: `[local syntax check] PYTHON SYNTAX ERROR:\n${detail}` };
    }
  }
  return null;
}

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

  if (TS_EXTS.has(ext) && supportsNodeStripTypes()) {
    try {
      await exec(process.execPath, ['--no-warnings', '--input-type=module', '-e', TS_CHECK_SCRIPT, full], {
        cwd, windowsHide: true, timeout: 5000
      });
      return { ok: true, note: '[local syntax check] ts syntax check passed' };
    } catch (error) {
      if (error?.code === 42) return null;
      const stderr = String(error.stderr || error.message || '').trim();
      // Ignore erasable-syntax-only warnings (e.g. enum/namespace) rather than producing false errors.
      if (/bad option|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|not a function/i.test(stderr)) return null;
      const detail = stderr.split(/\r?\n/).slice(0, 6).join('\n');
      return { ok: false, note: `[local syntax check] TS SYNTAX ERROR:\n${detail}` };
    }
  }

  if (ext === '.py') {
    return runPythonAstCheck(full, cwd);
  }

  return null;
}

function tokenize(line) {
  return String(line ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function lineSimilarity(a, b) {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta || !tb) return 0;
  if (ta === tb) return 10;
  if (ta.includes(tb) || tb.includes(ta)) return 6;
  const tokA = new Set(tokenize(ta));
  const tokB = tokenize(tb);
  if (!tokA.size || !tokB.length) return 0;
  let shared = 0;
  for (const t of tokB) {
    if (tokA.has(t)) shared++;
  }
  return shared > 0 ? (shared / Math.max(tokA.size, tokB.length)) * 5 : 0;
}

function formatLineRange(lines, startIdx, endIdx, maxChars = MAX_HINT_CHARS) {
  const out = [];
  let chars = 0;
  for (let i = startIdx; i <= endIdx && i < lines.length; i++) {
    const row = `${i + 1}: ${lines[i]}`;
    if (chars + row.length + 1 > maxChars && out.length > 0) {
      out.push('... [snippet truncated]');
      break;
    }
    out.push(row);
    chars += row.length + 1;
  }
  return out.join('\n');
}

// When an edit tool call fails to match oldText uniquely, locate the closest current lines on disk
// locally (0 web quota) and append them to the error so Copilot can fix oldText on its very next turn
// without spending an extra read round-trip.
export async function buildEditFailureHint(input, cwd) {
  if (!input || typeof input.path !== 'string' || !cwd) return null;
  const full = resolve(cwd, input.path);
  const info = await stat(full).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_HINT_FILE_BYTES) return null;

  let raw;
  try { raw = await readFile(full, 'utf8'); } catch { return null; }
  if (raw.includes('\0')) return null;

  const edits = Array.isArray(input.edits)
    ? input.edits.filter(e => typeof e?.oldText === 'string' && e.oldText.length > 0)
    : (typeof input.oldText === 'string' && input.oldText.length > 0 ? [{ oldText: input.oldText }] : []);
  if (!edits.length) return null;

  const normalizedRaw = raw.replace(/\r\n/g, '\n');
  const lines = normalizedRaw.split('\n');
  const displayPath = input.path.replaceAll('\\', '/');

  // Identify the failing edit: either missing (0 matches) or ambiguous (>1 matches).
  let targetOldText = edits[0].oldText.replace(/\r\n/g, '\n');
  let occurrences = [];
  for (const edit of edits) {
    const needle = edit.oldText.replace(/\r\n/g, '\n');
    const hits = [];
    let pos = normalizedRaw.indexOf(needle);
    while (pos >= 0 && hits.length < 8) {
      const lineNum = normalizedRaw.slice(0, pos).split('\n').length;
      hits.push(lineNum);
      pos = normalizedRaw.indexOf(needle, pos + Math.max(1, needle.length));
    }
    if (hits.length !== 1) {
      targetOldText = needle;
      occurrences = hits;
      break;
    }
  }

  // Case 1: Ambiguous (multiple exact matches) -> show exact match line numbers + surrounding context of first hit.
  if (occurrences.length > 1) {
    const firstIdx = Math.max(0, occurrences[0] - 1);
    const startIdx = Math.max(0, firstIdx - 6);
    const endIdx = Math.min(lines.length - 1, firstIdx + 12);
    const snippet = formatLineRange(lines, startIdx, endIdx);
    return `[Local edit recovery — oldText matched ${occurrences.length} places in ${displayPath} (at lines ${occurrences.join(', ')}); include more surrounding context from lines ${startIdx + 1}-${endIdx + 1} below instead of a separate read turn]\n${snippet}`;
  }

  // Case 2: Missing (0 exact matches) -> fuzzy-locate the closest window in the file.
  const needleLines = targetOldText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!needleLines.length) return null;
  const sampleNeedles = needleLines.slice(0, 6);
  let bestLine = 0;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    let score = lineSimilarity(lines[i], sampleNeedles[0]);
    if (score <= 0 && sampleNeedles.length > 1) {
      // Also allow anchor match on any non-trivial needle line.
      for (let k = 1; k < sampleNeedles.length; k++) {
        const alt = lineSimilarity(lines[i], sampleNeedles[k]);
        if (alt > score) score = alt * 0.85;
      }
    }
    if (score <= 0) continue;
    // Reward consecutive line alignment in a small window.
    for (let k = 1; k < sampleNeedles.length && i + k < lines.length; k++) {
      score += lineSimilarity(lines[i + k], sampleNeedles[k]) * 0.9;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (bestScore < 2) {
    // No strong match found; if file is small (<= 60 lines), return the whole file directly.
    if (lines.length <= 60) {
      return `[Local edit recovery — current full contents of ${displayPath} (lines 1-${lines.length}); fix oldText directly without a separate read turn]\n${formatLineRange(lines, 0, lines.length - 1)}`;
    }
    return null;
  }

  const windowRadius = 10;
  const startIdx = Math.max(0, bestLine - windowRadius);
  const endIdx = Math.min(lines.length - 1, bestLine + Math.max(needleLines.length, 4) + windowRadius);
  const snippet = formatLineRange(lines, startIdx, endIdx);
  return `[Local edit recovery — closest current lines in ${displayPath} (lines ${startIdx + 1}-${endIdx + 1}); fix oldText directly without a separate read turn]\n${snippet}`;
}
