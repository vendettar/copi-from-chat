import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Container, SelectList, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { PROACTIVE_COMPACTION_THRESHOLD } from './compaction.js';
import { cleanupLocalArtifacts, copyToClipboard, extractLastCodeBlock, getGitDiffSummary } from './commands.js';
import { formatModelPreference } from './model-preference.js';
import { assessToolRisk } from './safety.js';
import { isLockedByOther, logActivity, recordToolCheckpoint, saveConfig } from './storage.js';
import {
  createRoleMarkdownTransformer, createToolHistoryStore, formatDuration,
  summarizeToolCall, wrapCompactToolRenderer
} from './tool-ui.js';

const SELECT_THEME = {
  selectedPrefix: text => `\x1b[36m${text}\x1b[0m`,
  selectedText: text => `\x1b[1;36m${text}\x1b[0m`,
  description: text => `\x1b[2m${text}\x1b[0m`,
  scrollInfo: text => `\x1b[2m${text}\x1b[0m`,
  noMatch: text => `\x1b[33m${text}\x1b[0m`
};

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

function buildDetailLines(entry) {
  const statusLabel = entry.isError ? 'ERROR' : entry.status === 'running' ? 'RUNNING' : 'OK';
  const timing = entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : '';
  const argsJson = JSON.stringify(entry.args ?? {}, null, 2);
  const output = entry.outputText?.trim() ? entry.outputText : '(no text output)';
  return [
    `#${entry.index} ${entry.toolName} [${statusLabel}${timing}]`,
    `Call ID: ${entry.toolCallId}`,
    '',
    '--- Arguments ---',
    ...argsJson.split(/\r?\n/),
    '',
    '--- Output ---',
    ...output.split(/\r?\n/)
  ];
}

function createDetailViewerComponent(entry, { onBack, onClose, onCopy }) {
  const lines = buildDetailLines(entry);
  let offset = 0;
  const pageSize = 18;
  let copyHint = '';

  return {
    invalidate() {},
    render(width) {
      const visible = lines.slice(offset, offset + pageSize);
      const maxOffset = Math.max(0, lines.length - pageSize);
      const pos = lines.length > pageSize ? ` (lines ${offset + 1}-${Math.min(lines.length, offset + pageSize)}/${lines.length})` : '';
      const controls = [
        maxOffset > 0 ? '↑/↓/j/k scroll' : '',
        'c copy output',
        onBack ? 'b/Esc back' : 'Esc close',
        'q close'
      ].filter(Boolean).join(' · ');
      return [
        truncateToWidth(`\x1b[1;36mTool Detail${pos}\x1b[0m`, width),
        ...visible.map(line => truncateToWidth(line, width)),
        '',
        truncateToWidth(`\x1b[2m${controls}${copyHint ? `  [${copyHint}]` : ''}\x1b[0m`, width)
      ];
    },
    handleInput(data) {
      const maxOffset = Math.max(0, lines.length - pageSize);
      if (data === 'q' || data === '\x03') { onClose(); return; }
      if (data === '\x1b' || data === 'b') { (onBack ?? onClose)(); return; }
      if (data === 'j' || data === '\x1b[B') { offset = Math.min(maxOffset, offset + 1); return; }
      if (data === 'k' || data === '\x1b[A') { offset = Math.max(0, offset - 1); return; }
      if (data === '\x1b[6~' || data === ' ') { offset = Math.min(maxOffset, offset + pageSize); return; }
      if (data === '\x1b[5~') { offset = Math.max(0, offset - pageSize); return; }
      if (data === 'c' && onCopy) {
        copyHint = 'copying...';
        void onCopy(entry.outputText || JSON.stringify(entry.args ?? {}, null, 2))
          .then(() => { copyHint = 'copied!'; })
          .catch(() => { copyHint = 'copy failed'; });
      }
    }
  };
}

// Terminal integration, role distinction, compact tool rendering, safety guards, and slash commands.
export function createWebUI(browser, {
  copiPaths,
  sessionId,
  profile,
  sessionLock,
  modelController,
  providerControl,
  loadedInstructionFiles = [],
  autoApproveRisky = false,
  bellState = { enabled: true, minMs: 5000 },
  getSessionMessages = () => [],
  getLastAssistantText = () => undefined,
  getSessionMessageCount = () => getSessionMessages().length
} = {}) {
  let ui, workingMessage, footerTui;
  let edgeState = browser?.mode === 'shared' ? 'connecting' : 'idle';
  let turnStartedAt = 0;
  const toolStartTimes = new Map();
  const toolHistory = createToolHistoryStore();

  const requestFooterRender = () => {
    try { footerTui?.requestRender(); } catch { /* ignore */ }
  };

  const setEdgeState = next => {
    if (!next || next === edgeState) return;
    edgeState = next;
    requestFooterRender();
  };

  const onStatus = message => {
    if (typeof message === 'string') {
      if (/sign in to microsoft 365/i.test(message)) setEdgeState('sign-in required');
      else if (/sending to copilot|receiving copilot|waiting for copilot/i.test(message)) setEdgeState('ready');
    }
    if (!ui || message === workingMessage) return;
    workingMessage = message;
    ui.setWorkingMessage(message);
  };

  const openToolDetail = async (ctx, entry, allowBack = false) => {
    if (!ctx.hasUI || ctx.mode !== 'tui') {
      ctx.ui.notify(buildDetailLines(entry).join('\n'), 'info');
      return 'close';
    }
    return ctx.ui.custom((tui, _theme, _kb, done) => {
      const comp = createDetailViewerComponent(entry, {
        onBack: allowBack ? () => done('back') : null,
        onClose: () => done('close'),
        onCopy: async text => {
          await copyToClipboard(text);
          tui.requestRender();
        }
      });
      const origHandle = comp.handleInput.bind(comp);
      comp.handleInput = data => {
        origHandle(data);
        tui.requestRender();
      };
      return comp;
    });
  };

  const openInspectSelector = async (ctx, entries) => {
    while (true) {
      const items = [...entries].reverse().map(entry => {
        const icon = entry.isError ? '✗' : entry.status === 'running' ? '⋯' : '✓';
        const timing = entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : '';
        return {
          value: String(entry.index),
          label: `#${entry.index} ${icon} ${summarizeToolCall(entry.toolName, entry.args)}`,
          description: `${entry.isError ? 'error' : entry.status}${timing}`
        };
      });
      const chosen = await ctx.ui.custom((tui, _theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(`\x1b[1mInspect tool calls (${entries.length})\x1b[0m`, 0, 0));
        container.addChild(new Spacer(1));
        const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), SELECT_THEME);
        list.onSelect = item => done(Number(item.value));
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new Text('\x1b[2mUse ↑/↓ + Enter to inspect one tool call, Esc to close\x1b[0m', 0, 0));
        return {
          invalidate: () => container.invalidate(),
          render: width => container.render(width),
          handleInput: data => { list.handleInput(data); tui.requestRender(); }
        };
      });
      if (!chosen) return;
      const entry = toolHistory.getByIndex(chosen);
      if (!entry) return;
      const next = await openToolDetail(ctx, entry, true);
      if (next !== 'back') return;
    }
  };

  return {
    onStatus,
    setEdgeState,
    requestFooterRender,
    toolHistory,
    extension(pi) {
      if (typeof pi.registerMarkdownTransformer === 'function') {
        pi.registerMarkdownTransformer(createRoleMarkdownTransformer({
          getModelTag: () => modelController?.getPreference() ?? 'think'
        }));
      }

      pi.registerToolRenderer((name, next) => wrapCompactToolRenderer(name, next()));

      pi.on('session_start', (_event, ctx) => {
        toolHistory.hydrateFromMessages(getSessionMessages());
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
            theme.fg('dim', 'Enter send · Esc stop · Ctrl+O details · /model · /inspect · /diff · /copy · /resume · /new · /quit')
          ].map(line => truncateToWidth(line, width))
        }));
        ui.setFooter((tui, theme, data) => {
          footerTui = tui;
          const unsubscribe = data.onBranchChange(() => tui.requestRender());
          return {
            dispose() {
              if (footerTui === tui) footerTui = undefined;
              unsubscribe();
            },
            invalidate() {},
            render: width => {
              const branch = data.getGitBranch() ? ` (${data.getGitBranch()})` : '';
              const modelTag = modelController ? formatModelPreference(modelController.getPreference()) : 'think';
              const shortSid = sessionId ? sessionId.slice(0, 8) : '';
              const parts = [
                `${ctx.cwd}${branch}`,
                `model: ${modelTag}`,
                `Edge: ${edgeState}`,
                ...(shortSid ? [`session: ${shortSid}`] : []),
                'Ctrl+O details'
              ];
              return [truncateToWidth(theme.fg('dim', parts.join(' · ')), width)];
            }
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

      pi.on('tool_call', async (event, ctx) => {
        if (autoApproveRisky) return;
        const risk = assessToolRisk({ toolName: event.toolName, input: event.input, cwd: ctx.cwd });
        if (!risk.risky) return;
        if (ctx.hasUI) {
          const allowed = await ctx.ui.confirm(risk.title, risk.detail);
          if (!allowed) {
            void logActivity(copiPaths, 'tool_blocked', { sessionId, toolName: event.toolName, reason: risk.reason });
            return { block: true, reason: `Blocked by user confirmation: ${risk.reason}` };
          }
          return;
        }
        void logActivity(copiPaths, 'tool_blocked', { sessionId, toolName: event.toolName, reason: risk.reason, mode: ctx.mode });
        return {
          block: true,
          reason: `Blocked risky operation in non-interactive mode (${risk.reason}). Pass --yes if you want to allow it.`
        };
      });

      pi.on('agent_start', () => {
        turnStartedAt = Date.now();
        onStatus('Waiting for Copilot...');
      });

      pi.on('tool_execution_start', event => {
        onStatus('Running tools...');
        if (event?.toolCallId) {
          toolStartTimes.set(event.toolCallId, Date.now());
          toolHistory.recordStart({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          });
        }
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
        if (event?.toolCallId) {
          toolHistory.recordEnd({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: Boolean(event.isError),
            result: event.result,
            durationMs
          });
        }
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

      pi.on('agent_end', () => {
        onStatus();
        const elapsed = turnStartedAt ? Date.now() - turnStartedAt : 0;
        turnStartedAt = 0;
        if (ui && bellState?.enabled && elapsed >= (bellState.minMs ?? 5000) && process.stdout.isTTY) {
          process.stdout.write('\x07');
        }
      });

      pi.on('session_shutdown', async event => {
        ui = undefined;
        footerTui = undefined;
        workingMessage = undefined;
        toolStartTimes.clear();
        const empty = getSessionMessageCount() === 0;
        if (copiPaths && sessionId) {
          await logActivity(copiPaths, 'session_end', { sessionId, reason: event?.reason ?? 'shutdown', empty });
        }
        try {
          if (browser?.mode === 'shared') {
            await browser.close({ closeTab: empty });
          } else if (typeof browser?.close === 'function') {
            await browser.close();
          }
        } finally {
          await sessionLock?.release();
        }
      });

      pi.on('session_before_compact', (_event, ctx) => {
        ctx.ui.notify('Manual Pi compaction is disabled; Copi compacts older turns automatically on resume after 12 messages.', 'info');
        return { cancel: true };
      });

      pi.registerCommand('inspect', {
        description: 'Inspect a specific tool call in detail (usage: /inspect [number])',
        handler: async (args, ctx) => {
          toolHistory.hydrateFromMessages(getSessionMessages());
          const entries = toolHistory.list();
          if (!entries.length) {
            ctx.ui.notify('No tool calls recorded in this session yet.', 'info');
            return;
          }
          const raw = (args ?? '').trim();
          if (raw) {
            const idx = Number(raw.replace(/^#/, ''));
            const entry = Number.isInteger(idx) ? toolHistory.getByIndex(idx) : null;
            if (!entry) {
              ctx.ui.notify(`Tool call #${raw} not found (available: 1-${entries.length}).`, 'warning');
              return;
            }
            await openToolDetail(ctx, entry, false);
            return;
          }
          if (!ctx.hasUI || ctx.mode !== 'tui') {
            ctx.ui.notify(entries.map(e => `#${e.index} ${e.isError ? '✗' : '✓'} ${summarizeToolCall(e.toolName, e.args)}`).join('\n'), 'info');
            return;
          }
          await openInspectSelector(ctx, entries);
        }
      });

      pi.registerCommand('copy', {
        description: 'Copy the last assistant reply (or "/copy code" for the last code block)',
        handler: async (args, ctx) => {
          const reply = getLastAssistantText();
          if (!reply || !reply.trim()) {
            ctx.ui.notify('No assistant reply available to copy yet.', 'warning');
            return;
          }
          const mode = (args ?? '').trim().toLowerCase();
          const target = mode === 'code' ? extractLastCodeBlock(reply) : reply;
          if (!target) {
            ctx.ui.notify('No fenced code block found in the last reply.', 'warning');
            return;
          }
          try {
            await copyToClipboard(target);
            ctx.ui.notify(`Copied ${mode === 'code' ? 'last code block' : 'last reply'} (${target.length} chars) to clipboard.`, 'info');
          } catch (error) {
            ctx.ui.notify(`Could not copy to clipboard: ${error.message}`, 'error');
          }
        }
      });

      pi.registerCommand('diff', {
        description: 'Show git status and diff --stat for the current workspace',
        handler: async (_args, ctx) => {
          const result = await getGitDiffSummary(ctx.cwd);
          ctx.ui.notify(result.text, result.isGit ? 'info' : 'warning');
        }
      });

      pi.registerCommand('status', {
        description: 'Show session, context compaction, model, and Edge Browser Host status',
        handler: async (_args, ctx) => {
          const messageCount = getSessionMessageCount();
          const liveStatus = typeof browser?.getStatus === 'function'
            ? await browser.getStatus().catch(() => null)
            : null;
          if (liveStatus?.state) {
            setEdgeState(liveStatus.state === 'waiting_signin' ? 'sign-in required' : liveStatus.state);
          }
          const sessionName = typeof pi.getSessionName === 'function' ? pi.getSessionName() : undefined;
          const modelPref = modelController ? formatModelPreference(modelController.getPreference()) : 'think';
          const activeModel = liveStatus?.activeModel ?? modelController?.getLastSelectedLabel?.() ?? null;
          const pState = providerControl?.getState?.();
          const compactionNote = messageCount > PROACTIVE_COMPACTION_THRESHOLD
            ? `${messageCount} messages (proactive compaction active on resume/reconnect)`
            : `${messageCount}/${PROACTIVE_COMPACTION_THRESHOLD} messages before proactive compaction`;
          const hostDetail = liveStatus?.port ? ` (127.0.0.1:${liveStatus.port}, PID ${liveStatus.hostPid})` : '';
          ctx.ui.notify([
            `Workspace: ${ctx.cwd}`,
            `Session: ${sessionId ?? '(in-memory)'}${sessionName ? ` ("${sessionName}")` : ''}`,
            `Context: ${compactionNote}`,
            `Model: ${modelPref}${activeModel ? ` (active: ${activeModel})` : ''}`,
            `Edge: ${liveStatus?.state ?? edgeState}${hostDetail}${pState?.needsNewChat ? ' · web needs /reconnect or /new' : ''}`,
            `Instructions: ${loadedInstructionFiles.length ? loadedInstructionFiles.join(', ') : '(none)'}`,
            `Tools recorded: ${toolHistory.list().length} (Ctrl+O to expand, /inspect to view one)`,
            `Safety guard: ${autoApproveRisky ? 'auto-approved (--yes)' : 'confirm risky commands & outside writes'}`,
            `Completion bell: ${bellState?.enabled ? 'on' : 'off'} (/bell on|off)`
          ].join('\n'), 'info');
        }
      });

      pi.registerCommand('rename', {
        description: 'Rename the current saved session (shown in /resume)',
        handler: async (args, ctx) => {
          const name = (args ?? '').trim();
          if (!name) {
            const current = typeof pi.getSessionName === 'function' ? pi.getSessionName() : undefined;
            ctx.ui.notify(current ? `Current session name: "${current}". Usage: /rename <new name>` : 'Usage: /rename <session name>', 'info');
            return;
          }
          if (typeof pi.setSessionName === 'function') {
            pi.setSessionName(name);
            ctx.ui.notify(`Session renamed to "${name}".`, 'info');
          } else {
            ctx.ui.notify('Session rename is unavailable in this session.', 'warning');
          }
        }
      });

      pi.registerCommand('reconnect', {
        description: 'Open a fresh Edge tab and restore the saved local session on the next turn',
        handler: async (_args, ctx) => {
          if (!ctx.isIdle()) {
            ctx.ui.notify('Wait for the current response to finish or press Esc before /reconnect.', 'warning');
            return;
          }
          setEdgeState('connecting');
          providerControl?.resetWebConversation?.();
          try {
            if (typeof browser?.resetTab === 'function') {
              await browser.resetTab({ warm: true });
            }
            ctx.ui.notify('Opened a fresh Edge tab. Your local JSONL history is intact and will restore automatically on your next message.', 'info');
          } catch (error) {
            ctx.ui.notify(`Could not reset Edge tab: ${error.message}`, 'error');
          }
        }
      });

      pi.registerCommand('cleanup', {
        description: 'Prune old checkpoints and saved temp tool outputs (usage: /cleanup [days])',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim();
          const days = raw ? Number(raw) : 14;
          if (!Number.isFinite(days) || days < 0) {
            ctx.ui.notify('Usage: /cleanup [days] (e.g. /cleanup 7 or /cleanup 0)', 'warning');
            return;
          }
          const result = await cleanupLocalArtifacts({
            paths: copiPaths,
            maxAgeDays: days,
            activeSessionId: sessionId
          });
          const kb = (result.freedBytes / 1024).toFixed(1);
          ctx.ui.notify(`Cleaned ${result.removedFiles} file(s) older than ${days} day(s), freed ${kb} KB.`, 'info');
        }
      });

      pi.registerCommand('bell', {
        description: 'Toggle completion bell for long responses (usage: /bell [on|off])',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim().toLowerCase();
          if (raw === 'on' || raw === '1' || raw === 'true') bellState.enabled = true;
          else if (raw === 'off' || raw === '0' || raw === 'false') bellState.enabled = false;
          else if (!raw) bellState.enabled = !bellState.enabled;
          else {
            ctx.ui.notify('Usage: /bell [on|off]', 'warning');
            return;
          }
          if (copiPaths) await saveConfig(copiPaths, { bell: bellState.enabled }).catch(() => {});
          ctx.ui.notify(`Completion bell: ${bellState.enabled ? 'on' : 'off'}.`, 'info');
        }
      });

      pi.registerCommand('web', {
        description: 'Show workspace, session, browser mode, model preference, and tools',
        handler: async (_args, ctx) => {
          const browserMode = profile
            ? `isolated Edge profile "${profile}"`
            : browser?.mode === 'shared'
              ? 'shared Edge window (per-session tab)'
              : 'direct Edge session';
          const modelPref = modelController ? formatModelPreference(modelController.getPreference()) : null;
          const activeModel = modelController?.getLastSelectedLabel?.() ?? browser?.lastSelectedModel ?? null;
          const modelLine = modelPref
            ? `Model: ${modelPref}${activeModel ? ` (active: ${activeModel})` : ''}`
            : null;
          ctx.ui.notify([
            `Workspace: ${ctx.cwd}`,
            ...(sessionId ? [`Session: ${sessionId}`] : []),
            `Browser: ${browserMode} (${edgeState})`,
            ...(modelLine ? [modelLine] : []),
            ...(loadedInstructionFiles.length ? [`Instructions: ${loadedInstructionFiles.join(', ')}`] : []),
            'Tools: read, bash, edit, write, grep, find'
          ].join('\n'), 'info');
        }
      });
    }
  };
}
