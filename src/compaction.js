export const PROACTIVE_COMPACTION_THRESHOLD = 12;
export const DEFAULT_KEEP_RECENT = 6;

const CHECK_COMMAND_PATTERN = /\b(test|check|lint|typecheck|tsc|build|pytest|vitest|jest|mocha|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|npm\s+run\s+(?:test|check|lint|build)|git\s+status)\b/i;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function compactLine(text, maxLength = 220) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const chars = Array.from(cleaned);
  return chars.length <= maxLength ? cleaned : `${chars.slice(0, maxLength).join('')}...`;
}

function normalizePathLabel(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

function summarizeToolTarget(name, args = {}) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'bash' && typeof args.command === 'string') return compactLine(args.command, 140);
  if (typeof args.path === 'string') {
    const parts = [normalizePathLabel(args.path)];
    if (typeof args.pattern === 'string') parts.push(`pattern=${compactLine(args.pattern, 60)}`);
    if (typeof args.glob === 'string') parts.push(`glob=${args.glob}`);
    if (args.offset !== undefined || args.limit !== undefined) {
      parts.push(`range=${args.offset ?? 1}:${args.limit ?? 'end'}`);
    }
    return parts.join(' ');
  }
  if (typeof args.pattern === 'string') return `pattern=${compactLine(args.pattern, 80)}`;
  return compactLine(JSON.stringify(args), 120);
}

function findRecentCutIndex(messages, firstUserIndex, keepRecent) {
  let cut = Math.max(firstUserIndex + 1, messages.length - keepRecent);

  // Never split a toolResult sequence from its preceding assistant toolCall message.
  while (cut > firstUserIndex + 1 && messages[cut]?.role === 'toolResult') {
    cut--;
  }

  // Prefer starting recent turns at a user boundary if one is just 1-2 messages earlier
  // and still leaves older messages to compact.
  for (let probe = cut; probe > firstUserIndex + 1 && probe >= cut - 2; probe--) {
    if (messages[probe]?.role === 'user') {
      cut = probe;
      break;
    }
  }

  return cut;
}

function buildSummaryText(olderMessages, incompleteCheckpoints = []) {
  const userInstructions = [];
  const decisions = [];
  const modifiedPaths = new Set();
  const inspectedPaths = new Set();
  const toolEvidence = [];
  const errors = [];
  const checks = [];
  const callsById = new Map();

  for (const message of olderMessages) {
    if (message.role === 'user') {
      const text = extractText(message.content);
      if (text.trim()) userInstructions.push(text);
      continue;
    }

    if (message.role === 'assistant') {
      const text = extractText(message.content).trim();
      if (text) decisions.push(compactLine(text, 260));
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== 'toolCall') continue;
          const args = block.arguments ?? {};
          const target = summarizeToolTarget(block.name, args);
          callsById.set(block.id, { name: block.name, args, target });
          if (typeof args.path === 'string' && args.path.trim()) {
            const p = normalizePathLabel(args.path);
            if (block.name === 'write' || block.name === 'edit') modifiedPaths.add(p);
            else inspectedPaths.add(p);
          }
        }
      }
      continue;
    }

    if (message.role === 'toolResult') {
      const call = callsById.get(message.toolCallId);
      const toolName = message.toolName ?? call?.name ?? 'tool';
      const target = call?.target ? ` (${call.target})` : '';
      const resultText = extractText(message.content);
      const status = message.isError ? 'error' : 'ok';
      toolEvidence.push(`${toolName}${target} -> ${status}`);

      if (message.isError) {
        const excerpt = compactLine(resultText, 220) || 'Tool reported an error.';
        errors.push(`${toolName}${target}: ${excerpt}`);
      }

      if (toolName === 'bash' && call?.args?.command && CHECK_COMMAND_PATTERN.test(call.args.command)) {
        const lines = resultText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const tail = compactLine(lines.slice(-2).join(' | '), 200) || (message.isError ? 'failed' : 'passed');
        checks.push(`${compactLine(call.args.command, 100)} -> ${message.isError ? 'FAILED' : 'PASSED'} (${tail})`);
      }
    }
  }

  const sections = [
    `[Compacted earlier local session context: ${olderMessages.length} older messages summarized; initial task and recent turns kept verbatim. Saved local JSONL transcript is unchanged.]`
  ];

  // User instructions are NEVER shortened.
  if (userInstructions.length) {
    sections.push('## Earlier User Instructions (verbatim)');
    for (const [index, instruction] of userInstructions.entries()) {
      sections.push(`### Instruction ${index + 1}\n${instruction}`);
    }
  }

  if (decisions.length) {
    sections.push('## Key Decisions & Assistant Notes');
    for (const item of decisions.slice(-12)) sections.push(`- ${item}`);
  }

  if (modifiedPaths.size || inspectedPaths.size) {
    sections.push('## Paths');
    if (modifiedPaths.size) sections.push(`- Modified: ${[...modifiedPaths].slice(0, 40).join(', ')}`);
    const readOnly = [...inspectedPaths].filter(p => !modifiedPaths.has(p));
    if (readOnly.length) sections.push(`- Inspected/searched: ${readOnly.slice(0, 40).join(', ')}`);
  }

  if (toolEvidence.length) {
    sections.push('## Tool Execution Evidence');
    const maxItems = 24;
    const shown = toolEvidence.length > maxItems
      ? [...toolEvidence.slice(0, 8), `... (${toolEvidence.length - maxItems} intermediate tool calls omitted) ...`, ...toolEvidence.slice(-(maxItems - 8))]
      : toolEvidence;
    for (const item of shown) sections.push(`- ${item}`);
  }

  if (checks.length) {
    sections.push('## Check Results');
    for (const item of checks.slice(-10)) sections.push(`- ${item}`);
  }

  if (errors.length) {
    sections.push('## Errors');
    for (const item of errors.slice(-10)) sections.push(`- ${item}`);
  }

  if (incompleteCheckpoints.length) {
    sections.push('## Interrupted Tool Checkpoints');
    for (const cp of incompleteCheckpoints.slice(-6)) {
      const target = cp.args ? ` ${compactLine(JSON.stringify(cp.args), 120)}` : '';
      sections.push(`- ${cp.toolName} (${cp.toolCallId})${target} started at ${cp.ts} without a recorded completion; inspect local state before repeating.`);
    }
  }

  return sections.join('\n\n');
}

export function compactBootstrapMessages(messages, {
  threshold = PROACTIVE_COMPACTION_THRESHOLD,
  keepRecent = DEFAULT_KEEP_RECENT,
  incompleteCheckpoints = []
} = {}) {
  if (!Array.isArray(messages) || messages.length <= threshold) {
    if (incompleteCheckpoints.length && Array.isArray(messages) && messages.length > 0) {
      const note = {
        role: 'assistant',
        content: [{
          type: 'text',
          text: [
            '[Local checkpoint notice]',
            ...incompleteCheckpoints.slice(-6).map(cp =>
              `- Tool ${cp.toolName} (${cp.toolCallId}) started at ${cp.ts} without recorded completion; verify local state before repeating.`)
          ].join('\n')
        }]
      };
      return {
        compacted: false,
        messages: [...messages.slice(0, -1), note, messages.at(-1)],
        stats: {
          originalCount: messages.length,
          compactedCount: messages.length + 1,
          summarizedCount: 0,
          preservedInitial: true,
          recentCount: messages.length
        }
      };
    }
    return {
      compacted: false,
      messages,
      stats: {
        originalCount: Array.isArray(messages) ? messages.length : 0,
        compactedCount: Array.isArray(messages) ? messages.length : 0,
        summarizedCount: 0,
        preservedInitial: true,
        recentCount: Array.isArray(messages) ? messages.length : 0
      }
    };
  }

  const firstUserIndex = messages.findIndex(message => message.role === 'user');
  if (firstUserIndex < 0) {
    return {
      compacted: false,
      messages,
      stats: {
        originalCount: messages.length,
        compactedCount: messages.length,
        summarizedCount: 0,
        preservedInitial: false,
        recentCount: messages.length
      }
    };
  }

  const recentStart = findRecentCutIndex(messages, firstUserIndex, keepRecent);
  const olderMessages = messages.slice(firstUserIndex + 1, recentStart);
  if (!olderMessages.length) {
    return {
      compacted: false,
      messages,
      stats: {
        originalCount: messages.length,
        compactedCount: messages.length,
        summarizedCount: 0,
        preservedInitial: true,
        recentCount: messages.length
      }
    };
  }

  const prefix = messages.slice(0, firstUserIndex + 1);
  const recent = messages.slice(recentStart);
  const summaryMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: buildSummaryText(olderMessages, incompleteCheckpoints) }]
  };
  const compactedMessages = [...prefix, summaryMessage, ...recent];

  return {
    compacted: true,
    messages: compactedMessages,
    stats: {
      originalCount: messages.length,
      compactedCount: compactedMessages.length,
      summarizedCount: olderMessages.length,
      preservedInitial: true,
      recentCount: recent.length
    }
  };
}
