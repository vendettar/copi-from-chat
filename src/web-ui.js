import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { isLockedByOther, logActivity, recordToolCheckpoint } from './storage.js';

async function readSessionIdFromFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = await readFile(filePath, 'utf8');
    const firstLine = raw.split('\n').find(line => line.trim());
    if (!firstLine) return null;
    const header = JSON.parse(firstLine);
    return header?.type === 'session' && typeof header.id === 'string' ? header.id : null;
  } catch {
    return null;
  }
}

// Only terminal integration and session lifecycle hooks live here; Pi owns editing and tool rendering.
export function createWebUI(browser, {
  copiPaths,
  sessionId,
  profile,
  sessionLock,
  getSessionMessageCount = () => 0
} = {}) {
  let ui, workingMessage;
  const toolStartTimes = new Map();
  const onStatus = message => {
    if (!ui || message === workingMessage) return;
    workingMessage = message;
    ui.setWorkingMessage(message);
  };

  return {
    onStatus,
    extension(pi) {
      pi.registerToolRenderer((name, next) => {
        const renderer = next();
        if (name !== 'bash' || !renderer?.renderCall) return renderer;
        return {
          ...renderer,
          // Suppress Pi 1.5's per-second Bash stopwatch in regular mode so off-screen running rows
          // do not replay Git Bash scrollback; live output and final recorded duration remain intact.
          renderCall: (args, theme, context) => renderer.renderCall(args, theme, { ...context, executionStarted: false })
        };
      });

      pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        ui = ctx.ui;
        workingMessage = undefined;
        // Single ASCII frame disables Pi's 80 ms spinner timer and preserves Git Bash scrollback.
        ui.setWorkingIndicator({ frames: ['*'] });
        ui.setTitle(`Copi - ${basename(ctx.cwd)}`);
        ui.setHeader((_tui, theme) => ({
          invalidate() {},
          render: width => [
            theme.fg('accent', 'Copi · Copilot from Chat'),
            theme.fg('dim', 'Enter to send · Esc to stop · /new · /resume · /web · /quit')
          ].map(line => truncateToWidth(line, width))
        }));
        ui.setFooter((tui, theme, data) => {
          const unsubscribe = data.onBranchChange(() => tui.requestRender());
          return {
            dispose: unsubscribe, invalidate() {},
            render: width => [
              theme.fg('dim', `${ctx.cwd}${data.getGitBranch() ? ` (${data.getGitBranch()})` : ''}`)
            ].map(line => truncateToWidth(line, width))
          };
        });
      });

      pi.on('session_before_switch', async (event, ctx) => {
        if (!copiPaths || event?.reason !== 'resume' || !event?.targetSessionFile) return;
        const targetId = await readSessionIdFromFile(event.targetSessionFile);
        if (!targetId) return;
        const locked = await isLockedByOther(copiPaths.locksDir, `session-${targetId}`, sessionLock?.ownerId);
        if (locked) {
          ctx.ui?.notify(`Session ${targetId} is currently open in another copi window.`, 'warning');
          return { cancel: true };
        }
      });

      pi.on('agent_start', () => onStatus('Waiting for Copilot...'));

      pi.on('tool_execution_start', event => {
        onStatus('Running tools...');
        if (event?.toolCallId) toolStartTimes.set(event.toolCallId, Date.now());
        if (copiPaths && sessionId && event?.toolCallId) {
          void recordToolCheckpoint(copiPaths, {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: 'started',
            args: event.args
          });
          void logActivity(copiPaths, 'tool_start', { sessionId, toolCallId: event.toolCallId, toolName: event.toolName });
        }
      });

      pi.on('tool_execution_end', event => {
        const started = event?.toolCallId ? toolStartTimes.get(event.toolCallId) : undefined;
        if (event?.toolCallId) toolStartTimes.delete(event.toolCallId);
        const durationMs = started !== undefined ? Date.now() - started : undefined;
        if (copiPaths && sessionId && event?.toolCallId) {
          void recordToolCheckpoint(copiPaths, {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: event.isError ? 'error' : 'completed',
            isError: Boolean(event.isError),
            durationMs
          });
          void logActivity(copiPaths, 'tool_end', {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: Boolean(event.isError),
            durationMs
          });
        }
      });

      pi.on('agent_end', () => onStatus());

      pi.on('session_shutdown', async event => {
        ui = undefined;
        workingMessage = undefined;
        toolStartTimes.clear();
        const empty = getSessionMessageCount() === 0;
        if (copiPaths && sessionId) {
          await logActivity(copiPaths, 'session_end', { sessionId, reason: event?.reason ?? 'shutdown', empty });
        }
        try {
          if (browser?.mode === 'shared') {
            // Keep non-empty tabs alive on the Browser Host so /resume or --continue can reuse them.
            await browser.close({ closeTab: empty });
          } else if (typeof browser?.close === 'function') {
            await browser.close();
          }
        } finally {
          await sessionLock?.release();
        }
      });

      // Pi's token-based compaction is disabled; Copi handles proactive compaction on bootstrap/resume payloads.
      pi.on('session_before_compact', (_event, ctx) => {
        ctx.ui.notify('Manual Pi compaction is disabled; Copi compacts older turns automatically on resume after 12 messages.', 'info');
        return { cancel: true };
      });

      pi.registerCommand('web', {
        description: 'Show workspace, session, browser mode, and tools',
        handler: async (_args, ctx) => {
          const browserMode = profile
            ? `isolated Edge profile "${profile}"`
            : browser?.mode === 'shared'
              ? 'shared Edge window (per-session tab)'
              : 'direct Edge session';
          ctx.ui.notify([
            `Workspace: ${ctx.cwd}`,
            ...(sessionId ? [`Session: ${sessionId}`] : []),
            `Browser: ${browserMode}`,
            'Tools: read, bash, edit, write, grep, find'
          ].join('\n'), 'info');
        }
      });
    }
  };
}
