import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { summarizeToolCall } from './tool-ui.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

export function formatSessionMarkdown({ sessionId, sessionName, cwd, messages = [] }) {
  const lines = [
    `# Copi Session Export${sessionName ? ` — ${sessionName}` : ''}`,
    '',
    `- **Session ID**: \`${sessionId ?? '(in-memory)'}\``,
    `- **Workspace**: \`${String(cwd ?? '').replaceAll('\\', '/')}\``,
    `- **Exported**: ${new Date().toISOString()}`,
    `- **Messages**: ${messages.length}`,
    ''
  ];

  const modifiedFiles = new Set();
  for (const msg of messages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'toolCall' && ['write', 'edit'].includes(block.name) && typeof block.arguments?.path === 'string') {
          modifiedFiles.add(block.arguments.path.replaceAll('\\', '/'));
        }
      }
    }
  }

  if (modifiedFiles.size) {
    lines.push('## Files Modified', '');
    for (const file of modifiedFiles) lines.push(`- \`${file}\``);
    lines.push('');
  }

  lines.push('## Transcript', '');
  for (const msg of messages) {
    if (msg?.role === 'user') {
      lines.push('### You', '', textOf(msg.content).trim() || '_(empty)_', '');
    } else if (msg?.role === 'assistant') {
      const text = textOf(msg.content).trim();
      const calls = Array.isArray(msg.content) ? msg.content.filter(b => b?.type === 'toolCall') : [];
      if (text) {
        lines.push('### Copi', '', text, '');
      }
      if (calls.length) {
        lines.push('**Tools called:**', '');
        for (const call of calls) {
          lines.push(`- \`${summarizeToolCall(call.name, call.arguments)}\``);
        }
        lines.push('');
      }
    } else if (msg?.role === 'toolResult' && msg.isError) {
      const errText = textOf(msg.content).trim().split(/\r?\n/)[0] ?? 'Tool failed';
      lines.push(`> Tool error (\`${msg.toolName ?? 'tool'}\`): ${errText}`, '');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

export async function exportSessionToFile({ cwd, sessionId, sessionName, messages, outputPath }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `copi-session-${(sessionId ?? 'export').slice(0, 8)}-${stamp}.md`;
  const target = outputPath?.trim()
    ? resolve(cwd, outputPath.trim())
    : join(cwd, defaultName);
  const markdown = formatSessionMarkdown({ sessionId, sessionName, cwd, messages });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, markdown, 'utf8');
  return { path: target, bytes: Buffer.byteLength(markdown, 'utf8') };
}
