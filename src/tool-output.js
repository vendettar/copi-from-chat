import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Proactive soft budgets for outgoing tool-result batches (~10,000 JSON chars total, ~5,000 per result).
// User instructions are never shortened; full tool output is always saved locally when shortened.
export const TOOL_TEXT_BUDGET = 10000;
export const PER_RESULT_TOOL_TEXT_BUDGET = 5000;
const MIN_REPEAT_FOLD = 4;
const size = content => JSON.stringify(content).length;

// Strip ANSI CSI/OSC/single-char escapes, collapse carriage-return progress bar frames,
// and fold long runs of identical consecutive terminal lines to maximize information density.
const ANSI_ESCAPE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export function denoiseToolOutput(text) {
  if (typeof text !== 'string' || !text) return text;
  let cleaned = text.includes('\x1b') ? text.replace(ANSI_ESCAPE, '') : text;

  const hadCR = cleaned.includes('\r');
  if (hadCR) {
    cleaned = cleaned
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => {
        if (!line.includes('\r')) return line;
        // Keep the last non-empty carriage-return frame (what a terminal actually displays).
        const frames = line.split('\r');
        for (let i = frames.length - 1; i >= 0; i--) {
          if (frames[i].length > 0) return frames[i];
        }
        return '';
      })
      .join('\n');
  }

  const lines = cleaned.split('\n');
  if (lines.length < MIN_REPEAT_FOLD) return cleaned;

  const folded = [];
  let changed = cleaned !== text;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    const count = j - i;
    if (count >= MIN_REPEAT_FOLD && line.trim().length > 0) {
      folded.push(line, `[... repeated ${count - 1} more times ...]`);
      changed = true;
    } else {
      for (let k = i; k < j; k++) folded.push(lines[k]);
    }
    i = j;
  }
  return changed ? folded.join('\n') : text;
}

async function saveOutput(text, signal) {
  const path = join(tmpdir(), `copi-output-${randomUUID()}.txt`);
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
  return path.replaceAll('\\', '/');
}

function preview(text, path, budget) {
  const characters = Array.from(text); // Do not split surrogate pairs when shortening Unicode output.
  const note = `\n\n[Partial output]\nSaved tool result: ${path}\nUse read with offset/limit to inspect this file in small sections. For very long lines, use bash to inspect a small byte range.`;
  const content = count => {
    const head = Math.ceil(count * 2 / 3), tail = count - head;
    return [{ type: 'text', text: characters.slice(0, head).join('') + '\n\n[... middle omitted ...]\n\n'
      + (tail ? characters.slice(-tail).join('') : '') + note }];
  };
  let low = 0, high = characters.length - 1, best = content(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), candidate = content(middle);
    if (size(candidate) <= budget) { best = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

function rawTextOf(content) {
  return typeof content === 'string' ? content : content.map(block => block.text).join('\n\n');
}

export async function limitToolResults(messages, {
  signal,
  save = saveOutput,
  batchBudget = TOOL_TEXT_BUDGET,
  perResultBudget = PER_RESULT_TOOL_TEXT_BUDGET,
  denoise = true
} = {}) {
  signal?.throwIfAborted();
  let denoisedAny = false;
  // Denoise bash terminal output (ANSI, \r progress frames, spammy repeats) BEFORE budgeting.
  // Never alter read/grep/find output so exact-match edit targets stay 100% verbatim.
  const entries = messages.map((message, index) => {
    if (message.role !== 'toolResult') return null;
    const rawText = rawTextOf(message.content);
    const shouldDenoise = denoise && message.toolName === 'bash';
    const workingText = shouldDenoise ? denoiseToolOutput(rawText) : rawText;
    const denoised = workingText !== rawText;
    if (denoised) denoisedAny = true;
    const workingContent = denoised ? [{ type: 'text', text: workingText }] : message.content;
    return { message, index, rawText, workingText, workingContent, denoised };
  }).filter(Boolean);

  const totalSize = entries.reduce((sum, item) => sum + size(item.workingContent), 0);
  const anyOversized = entries.some(item => size(item.workingContent) > perResultBudget);
  if (totalSize <= batchBudget && !anyOversized) {
    if (!denoisedAny) return messages;
    const next = [...messages];
    for (const item of entries) {
      if (item.denoised) next[item.index] = { ...item.message, content: item.workingContent };
    }
    return next;
  }

  const limited = [...messages];
  for (const item of entries) {
    if (item.denoised) limited[item.index] = { ...item.message, content: item.workingContent };
  }
  let remaining = batchBudget, count = entries.length;
  // Small results stay whole; large results share the remaining batch budget and obey the per-result cap.
  for (const item of entries.sort((a, b) => size(a.workingContent) - size(b.workingContent))) {
    signal?.throwIfAborted();
    const fairShare = Math.max(512, Math.floor(remaining / count--));
    const share = Math.min(perResultBudget, fairShare);
    let content = item.workingContent;
    if (size(content) > share) {
      // Always save the original unmodified raw output to disk for full inspection.
      const path = await save(item.rawText, signal);
      signal?.throwIfAborted();
      content = preview(item.workingText, path, share);
      // Change only the transport copy. Keep tool IDs, errors and the local transcript intact.
      limited[item.index] = { ...item.message, content };
    }
    remaining -= size(content);
  }
  return limited;
}
