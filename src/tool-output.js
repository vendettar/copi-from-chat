import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Proactive soft budgets for outgoing tool-result batches (~10,000 JSON chars total, ~5,000 per result).
// User instructions are never shortened; full tool output is always saved locally when shortened.
export const TOOL_TEXT_BUDGET = 10000;
export const PER_RESULT_TOOL_TEXT_BUDGET = 5000;
const size = content => JSON.stringify(content).length;

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

export async function limitToolResults(messages, {
  signal,
  save = saveOutput,
  batchBudget = TOOL_TEXT_BUDGET,
  perResultBudget = PER_RESULT_TOOL_TEXT_BUDGET
} = {}) {
  signal?.throwIfAborted();
  const results = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'toolResult');
  const totalSize = results.reduce((sum, { message }) => sum + size(message.content), 0);
  const anyOversized = results.some(({ message }) => size(message.content) > perResultBudget);
  if (totalSize <= batchBudget && !anyOversized) return messages;

  const limited = [...messages];
  let remaining = batchBudget, count = results.length;
  // Small results stay whole; large results share the remaining batch budget and obey the per-result cap.
  for (const { message, index } of results.sort((a, b) => size(a.message.content) - size(b.message.content))) {
    signal?.throwIfAborted();
    const fairShare = Math.max(512, Math.floor(remaining / count--));
    const share = Math.min(perResultBudget, fairShare);
    let content = message.content;
    if (size(content) > share) {
      const text = typeof content === 'string' ? content : content.map(block => block.text).join('\n\n');
      const path = await save(text, signal);
      signal?.throwIfAborted();
      content = preview(text, path, share);
      // Change only the transport copy. Keep tool IDs, errors and the local transcript intact.
      limited[index] = { ...message, content };
    }
    remaining -= size(content);
  }
  return limited;
}
