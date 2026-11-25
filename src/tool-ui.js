import { Text } from '@earendil-works/pi-tui';
import { formatModelPreference } from './model-preference.js';

function singleLine(text, max = 96) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('')}…`;
}

export function formatDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return `Took ${Math.round(durationMs)}ms`;
  return `Took ${(durationMs / 1000).toFixed(1)}s`;
}

export function extractResultText(result) {
  if (!result) return '';
  const content = result.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

export function summarizeToolCall(toolName, args = {}) {
  if (!args || typeof args !== 'object') return toolName;
  if (toolName === 'bash') {
    return `bash ${singleLine(args.command ?? '', 90)}`;
  }
  if (toolName === 'read') {
    const target = String(args.path ?? '').replaceAll('\\', '/');
    const range = args.offset !== undefined || args.limit !== undefined
      ? ` (L${args.offset ?? 1}${args.limit !== undefined ? `+${args.limit}` : ''})`
      : '';
    return `read ${target}${range}`;
  }
  if (toolName === 'write') {
    const target = String(args.path ?? '').replaceAll('\\', '/');
    const lines = typeof args.content === 'string' ? args.content.split(/\r?\n/).length : 0;
    return `write ${target}${lines ? ` (${lines} lines)` : ''}`;
  }
  if (toolName === 'edit') {
    const target = String(args.path ?? '').replaceAll('\\', '/');
    const count = Array.isArray(args.edits) ? args.edits.length : 1;
    return `edit ${target}${count > 1 ? ` (${count} edits)` : ''}`;
  }
  if (toolName === 'grep') {
    const scope = args.path && args.path !== '.' ? ` in ${String(args.path).replaceAll('\\', '/')}` : '';
    const glob = args.glob ? ` [${args.glob}]` : '';
    return `grep "${singleLine(args.pattern ?? '', 40)}"${scope}${glob}`;
  }
  if (toolName === 'find') {
    const scope = args.path && args.path !== '.' ? ` in ${String(args.path).replaceAll('\\', '/')}` : '';
    return `find "${singleLine(args.pattern ?? '', 40)}"${scope}`;
  }
  return `${toolName} ${singleLine(JSON.stringify(args), 70)}`;
}

export function summarizeToolResultLine(toolName, result, { isPartial = false, isError = false, durationMs } = {}) {
  const text = extractResultText(result);
  const lines = text ? text.split(/\r?\n/).filter(l => l.trim()) : [];
  const timing = !isPartial ? formatDuration(durationMs) : '';

  if (isPartial) {
    const live = lines.length ? singleLine(lines.at(-1), 90) : 'running…';
    return live;
  }

  if (isError) {
    const errLine = lines.length ? singleLine(lines.at(-1), 90) : 'failed';
    return [errLine, timing].filter(Boolean).join(' · ');
  }

  const lineCount = text ? text.split(/\r?\n/).length : 0;
  let stat;
  if (!text.trim()) {
    stat = 'done';
  } else if (toolName === 'grep' || toolName === 'find') {
    stat = text.trim() === 'No matches.' ? 'no matches' : `${lines.length} match${lines.length === 1 ? '' : 'es'}`;
  } else if (toolName === 'write' || toolName === 'edit') {
    stat = singleLine(lines[0] ?? 'updated', 72);
  } else {
    stat = `${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }
  return [stat, timing].filter(Boolean).join(' · ');
}

export function wrapCompactToolRenderer(name, baseRenderer) {
  if (!baseRenderer) return baseRenderer;
  const knownTool = ['read', 'bash', 'edit', 'write', 'grep', 'find'].includes(name);
  if (!knownTool) return baseRenderer;

  return {
    ...baseRenderer,
    renderCall(args, theme, context) {
      if (context.expanded && baseRenderer.renderCall) {
        const nextCtx = name === 'bash' ? { ...context, executionStarted: false } : context;
        return baseRenderer.renderCall(args, theme, nextCtx);
      }
      const icon = context.isPartial
        ? theme.fg('accent', '⋯')
        : context.isError
          ? theme.fg('error', '✗')
          : theme.fg('success', '✓');
      const title = summarizeToolCall(name, args);
      const timing = !context.isPartial && context.durationMs !== undefined
        ? theme.fg('dim', ` · ${formatDuration(context.durationMs)}`)
        : '';
      const hint = !context.isPartial ? theme.fg('dim', ' (Ctrl+O / click)') : '';
      return new Text(`${icon} ${theme.fg('toolTitle', title)}${timing}${hint}`, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (options.expanded && baseRenderer.renderResult) {
        return baseRenderer.renderResult(result, options, theme, context);
      }
      const summary = summarizeToolResultLine(name, result, {
        isPartial: options.isPartial,
        isError: context.isError,
        durationMs: context.durationMs
      });
      const color = context.isError ? 'error' : 'dim';
      return new Text(theme.fg(color, `  ↳ ${summary}`), 0, 0);
    }
  };
}

function formatShortTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function createRoleMarkdownTransformer({ getModelTag = () => 'think' } = {}) {
  return (markdown, context = {}) => {
    if (typeof markdown !== 'string' || !markdown.trim()) return markdown;
    const time = formatShortTime(context.timestamp);
    const timeSuffix = time ? ` · ${time}` : '';

    if (context.messageType === 'user') {
      if (markdown.startsWith('**▌ You')) return markdown;
      return `**▌ You${timeSuffix}**\n\n${markdown}`;
    }

    if (context.messageType === 'assistant') {
      if (markdown.startsWith('---\n**▌ Copi') || markdown.startsWith('**▌ Copi')) return markdown;
      const modelTag = formatModelPreference(getModelTag());
      return `---\n**▌ Copi** \`${modelTag}\`${timeSuffix}\n\n${markdown}`;
    }

    return markdown;
  };
}

export function createToolHistoryStore(maxEntries = 60) {
  const entries = [];
  const byId = new Map();

  const recordStart = ({ toolCallId, toolName, args }) => {
    if (!toolCallId) return;
    const existing = byId.get(toolCallId);
    if (existing) return existing;
    const entry = {
      index: entries.length + 1,
      toolCallId,
      toolName: toolName ?? 'tool',
      args: args ?? {},
      status: 'running',
      isError: false,
      durationMs: undefined,
      outputText: '',
      startedAt: Date.now()
    };
    entries.push(entry);
    byId.set(toolCallId, entry);
    if (entries.length > maxEntries) {
      const removed = entries.shift();
      if (removed) byId.delete(removed.toolCallId);
    }
    return entry;
  };

  const recordEnd = ({ toolCallId, toolName, isError, result, durationMs }) => {
    if (!toolCallId) return;
    let entry = byId.get(toolCallId);
    if (!entry) entry = recordStart({ toolCallId, toolName, args: {} });
    entry.status = isError ? 'error' : 'done';
    entry.isError = Boolean(isError);
    entry.durationMs = durationMs ?? (Date.now() - entry.startedAt);
    if (result) entry.outputText = extractResultText(result);
    return entry;
  };

  const hydrateFromMessages = messages => {
    if (!Array.isArray(messages) || entries.length > 0) return;
    for (const msg of messages) {
      if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === 'toolCall' && block.id) {
            recordStart({ toolCallId: block.id, toolName: block.name, args: block.arguments });
          }
        }
      } else if (msg?.role === 'toolResult' && msg.toolCallId) {
        recordEnd({
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          isError: msg.isError,
          result: msg
        });
      }
    }
  };

  return {
    recordStart,
    recordEnd,
    hydrateFromMessages,
    list: () => [...entries],
    getByIndex: idx => entries.find(item => item.index === idx) ?? null,
    clear: () => { entries.length = 0; byId.clear(); }
  };
}
