import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Container, SelectList, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { PROACTIVE_COMPACTION_THRESHOLD } from './compaction.js';
import {
  appendProjectRule, cleanupLocalArtifacts, copyToClipboard, extractLastCodeBlock,
  formatRecentActivity, getGitDiffSummary, readProjectRules, runLocalCommand
} from './commands.js';
import { runDoctor } from './doctor.js';
import { formatModelPreference } from './model-preference.js';
import { normalizeCliPath } from './paths.js';
import { buildEditFailureHint, runPostEditSyntaxCheck } from './post-edit-check.js';
import { expandFileMentions } from './precontext.js';
import { renderPromptTemplate } from './prompts.js';
import { formatQuotaShort, readTodayQuota } from './quota.js';
import { assessToolRisk } from './safety.js';
import { isLockedByOther, logActivity, recordToolCheckpoint, saveConfig } from './storage.js';
import {
  createRoleMarkdownTransformer, createToolHistoryStore, formatDuration,
  summarizeToolCall, wrapCompactToolRenderer
} from './tool-ui.js';
import { createUndoManager } from './undo.js';

const ALL_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find'];
const READONLY_TOOLS = ['read', 'grep', 'find'];
const CLI_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return null; }
})();

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

// Terminal integration, role distinction, compact tool rendering, safety guards, quota telemetry, and slash commands.
export function createWebUI(browser, {
  cwd = process.cwd(),
  copiPaths,
  sessionId,
  profile,
  sessionLock,
  modelController,
  providerControl,
  loadedInstructionFiles = [],
  promptTemplates = [],
  allowedDirs = [],
  shellPath,
  autoApproveRisky = false,
  readonlyState = { enabled: false },
  bellState = { enabled: true, minMs: 5000 },
  quotaState = { record: null },
  getSessionMessages = () => [],
  getLastAssistantText = () => undefined,
  getSessionMessageCount = () => getSessionMessages().length,
  onShutdownCleanup = () => {}
} = {}) {
  let ui, workingMessage, footerTui;
  let edgeState = browser?.mode === 'shared' ? 'connecting' : 'idle';
  let turnStartedAt = 0;
  let pendingRunContext = null;
  const sessionAllowedDirs = [...new Set(
    (Array.isArray(allowedDirs) ? allowedDirs : [])
      .filter(d => typeof d === 'string' && d.trim())
      .map(d => resolve(cwd, normalizeCliPath(d)))
  )];
  const toolStartTimes = new Map();
  const toolHistory = createToolHistoryStore();
  const undoManager = createUndoManager(cwd);

  const consumePendingRunContext = text => {
    if (!pendingRunContext) return { text, attachedRun: null };
    const attachedRun = pendingRunContext;
    pendingRunContext = null;
    return {
      text: `${text}\n\n${attachedRun.promptBlock}`,
      attachedRun
    };
  };

  const requestFooterRender = () => {
    try { footerTui?.requestRender(); } catch { /* ignore */ }
  };

  const setEdgeState = next => {
    if (!next || next === edgeState) return;
    edgeState = next;
    requestFooterRender();
  };

  const updateQuotaRecord = record => {
    quotaState.record = record;
    requestFooterRender();
  };

  const onStatus = message => {
    if (typeof message === 'string') {
      if (/sign in to microsoft 365/i.test(message)) setEdgeState('sign-in required');
      else if (/sending to copilot|receiving copilot|waiting for copilot|thinking deeply|planning tool calls|drafting answer/i.test(message)) setEdgeState('ready');
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
    updateQuotaRecord,
    requestFooterRender,
    toolHistory,
    undoManager,
    extension(pi) {
      if (typeof pi.registerMarkdownTransformer === 'function') {
        pi.registerMarkdownTransformer(createRoleMarkdownTransformer({
          getModelTag: () => modelController?.getEffectiveDisplayPreference?.() ?? modelController?.getPreference?.() ?? 'smart'
        }));
      }

      pi.registerToolRenderer((name, next) => wrapCompactToolRenderer(name, next()));

      pi.on('session_start', (_event, ctx) => {
        toolHistory.hydrateFromMessages(getSessionMessages());
        if (ctx.mode !== 'tui') return;
        ui = ctx.ui;
        workingMessage = undefined;
        ui.setWorkingIndicator({ frames: ['*'] });
        ui.setTitle(`Copi - ${basename(ctx.cwd)}`);
        ui.setHeader((_tui, theme) => ({
          invalidate() {},
          render: width => [
            theme.fg('accent', 'Copi · Copilot from Chat'),
            theme.fg('dim', 'Enter send · Esc stop · Ctrl+O details · /model · /think · /run · /allow-dir · /quota · /undo · /resume · /quit')
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
              const modelTag = modelController ? formatModelPreference(modelController.getPreference()) : 'smart';
              const quotaText = quotaState.record ? formatQuotaShort(quotaState.record) : '';
              const shortSid = sessionId ? sessionId.slice(0, 8) : '';
              const parts = [
                `${ctx.cwd}${branch}`,
                ...(readonlyState.enabled ? ['[RO]'] : []),
                `model: ${modelTag}`,
                `Edge: ${edgeState}`,
                ...(quotaText ? [quotaText] : []),
                ...(shortSid ? [`session: ${shortSid}`] : []),
                'Ctrl+O details'
              ];
              return [truncateToWidth(theme.fg('dim', parts.join(' · ')), width)];
            }
          };
        });
      });

      // Expand @path/to/file mentions, plain workspace/allowedDir paths, and any pending /run output locally (0 extra web turns!).
      pi.on('input', async (event, ctx) => {
        if (!event?.text || event.text.trimStart().startsWith('/')) return { action: 'continue' };
        const expanded = await expandFileMentions(event.text, ctx.cwd, { allowedDirs: sessionAllowedDirs });
        const withRun = consumePendingRunContext(expanded.text);
        if (!expanded.loadedFiles.length && !withRun.attachedRun) return { action: 'continue' };
        if (expanded.loadedEntries?.length) providerControl?.notePreloadedFiles?.(expanded.loadedEntries);
        const notes = [];
        if (expanded.loadedFiles.length) notes.push(`files: ${expanded.loadedFiles.join(', ')}`);
        if (withRun.attachedRun) notes.push(`/run output: ${withRun.attachedRun.command} (exit ${withRun.attachedRun.exitCode})`);
        ctx.ui?.notify(`Preloaded locally (${notes.join(' · ')})`, 'info');
        return { action: 'transform', text: withRun.text };
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
        if (readonlyState.enabled && ['write', 'edit', 'bash'].includes(event.toolName)) {
          return {
            block: true,
            reason: `Blocked "${event.toolName}" because read-only mode is active. Use /readonly off to allow edits or shell commands.`
          };
        }

        if (!autoApproveRisky) {
          const risk = assessToolRisk({ toolName: event.toolName, input: event.input, cwd: ctx.cwd, allowedDirs: sessionAllowedDirs });
          if (risk.risky) {
            if (ctx.hasUI) {
              const allowed = await ctx.ui.confirm(risk.title, risk.detail);
              if (!allowed) {
                void logActivity(copiPaths, 'tool_blocked', { sessionId, toolName: event.toolName, reason: risk.reason });
                return { block: true, reason: `Blocked by user confirmation: ${risk.reason}` };
              }
            } else {
              void logActivity(copiPaths, 'tool_blocked', { sessionId, toolName: event.toolName, reason: risk.reason, mode: ctx.mode });
              return {
                block: true,
                reason: `Blocked risky operation in non-interactive mode (${risk.reason}). Pass --yes if you want to allow it.`
              };
            }
          }
        }

        // Capture pre-edit file snapshot for /undo right before write/edit runs.
        if ((event.toolName === 'write' || event.toolName === 'edit') && typeof event.input?.path === 'string') {
          await undoManager.captureBeforeModify(event.input.path);
        }
      });

      const appendToolText = (existing, suffix) => {
        const blocks = Array.isArray(existing) ? existing.map(b => ({ ...b })) : [];
        const lastTextIdx = blocks.findLastIndex(b => b?.type === 'text' && typeof b.text === 'string');
        if (lastTextIdx >= 0) {
          blocks[lastTextIdx].text = `${blocks[lastTextIdx].text}${suffix}`;
          return blocks;
        }
        return [...blocks, { type: 'text', text: suffix.trimStart() }];
      };

      // Zero-cost local hooks on tool_result:
      // 1) When edit fails to match oldText, attach the closest current file lines to save a read turn.
      // 2) After successful write/edit on JS/TS/JSON/Python, attach an instant local syntax check.
      pi.on('tool_result', async (event, ctx) => {
        if (event.isError && event.toolName === 'edit') {
          const hint = await buildEditFailureHint(event.input, ctx.cwd).catch(() => null);
          if (!hint) return;
          return { content: appendToolText(event.content, `\n\n${hint}`) };
        }
        if (event.isError || !['write', 'edit'].includes(event.toolName)) return;
        const targetPath = event.input?.path;
        if (typeof targetPath !== 'string') return;
        const check = await runPostEditSyntaxCheck(targetPath, ctx.cwd);
        if (!check) return;
        return { content: appendToolText(event.content, `\n${check.note}`) };
      });

      pi.on('agent_start', () => {
        turnStartedAt = Date.now();
        undoManager.beginTurn();
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
        undoManager.commitTurn();
        modelController?.clearOneShotPreference?.();
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
        onShutdownCleanup();
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

      pi.registerCommand('think', {
        description: 'Run ONE prompt with Think deeper, then restore your previous model preference',
        handler: async (args, ctx) => {
          const prompt = (args ?? '').trim();
          if (!prompt) {
            ctx.ui.notify('Usage: /think <your question or task>', 'info');
            return;
          }
          modelController?.setOneShotPreference?.({ kind: 'preset', name: 'think' });
          ctx.ui.notify('Using Think deeper for this turn only...', 'info');
          const expanded = await expandFileMentions(prompt, ctx.cwd, { allowedDirs: sessionAllowedDirs });
          if (expanded.loadedEntries?.length) providerControl?.notePreloadedFiles?.(expanded.loadedEntries);
          const withRun = consumePendingRunContext(expanded.text);
          pi.sendUserMessage(withRun.text);
        }
      });

      pi.registerCommand('quota', {
        description: 'Show today\'s web turn count by model tier and quota-saving tips',
        handler: async (_args, ctx) => {
          const record = await readTodayQuota(copiPaths);
          updateQuotaRecord(record);
          const pref = modelController ? formatModelPreference(modelController.getPreference()) : 'smart';
          ctx.ui.notify([
            `Daily Copilot web turns (${record.date}): ${record.counts.total}`,
            `  think: ${record.counts.think}${record.thinkLimited ? ' (daily cap detected today — auto-using quick)' : ''}`,
            `  quick: ${record.counts.quick}`,
            `  auto:  ${record.counts.auto}`,
            ...(record.counts.index ? [`  index: ${record.counts.index}`] : []),
            `Current model preference: ${pref}`,
            'Quota tips: use /model quick + /think <prompt>, run local checks via /run <cmd> (auto-attaches to next prompt), use /allow-dir <dir> for multi-dir preloading, and use /diff /undo /inspect locally (0 quota).'
          ].join('\n'), 'info');
        }
      });

      pi.registerCommand('run', {
        description: 'Run a local shell command at 0 web quota and auto-attach its output once to your next prompt',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim();
          if (!raw) {
            const pendingNote = pendingRunContext
              ? `Pending /run output ready to attach: "${pendingRunContext.command}" (exit ${pendingRunContext.exitCode}). Use "/run --clear" to drop it.`
              : 'Usage: /run <command> (runs locally at 0 web quota and attaches output to your next message).';
            ctx.ui.notify(pendingNote, 'info');
            return;
          }
          if (raw === '--clear' || raw === 'clear') {
            pendingRunContext = null;
            ctx.ui.notify('Cleared pending /run output.', 'info');
            return;
          }
          ctx.ui.notify(`Running locally (0 quota): ${raw}`, 'info');
          try {
            const res = await runLocalCommand(raw, { cwd: ctx.cwd, shellPath });
            pendingRunContext = res;
            ctx.ui.notify([
              `$ ${res.command}  [exit ${res.exitCode}]`,
              res.output,
              '',
              'Saved locally: your next message (or /fix) will automatically include this output (0 extra bash turn; "/run --clear" to discard).'
            ].join('\n'), res.exitCode === 0 ? 'info' : 'warning');
          } catch (error) {
            ctx.ui.notify(`Local /run failed: ${error.message}`, 'error');
          }
        }
      });

      pi.registerCommand('allow-dir', {
        description: 'Authorize an extra directory for edits and zero-turn file preloading (usage: /allow-dir <dir|clear>)',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim();
          if (!raw || raw === 'list') {
            ctx.ui.notify(sessionAllowedDirs.length
              ? `Authorized extra directories:\n${sessionAllowedDirs.map(d => `  - ${d.replaceAll('\\', '/')}`).join('\n')}`
              : 'No extra directories authorized yet. Usage: /allow-dir <dir>', 'info');
            return;
          }
          if (raw === 'clear' || raw === '--clear') {
            sessionAllowedDirs.length = 0;
            ctx.ui.notify('Cleared extra authorized directories for this session.', 'info');
            return;
          }
          const target = resolve(ctx.cwd, normalizeCliPath(raw));
          const info = await stat(target).catch(() => null);
          if (!info || !info.isDirectory()) {
            ctx.ui.notify(`Directory not found: ${target.replaceAll('\\', '/')}`, 'warning');
            return;
          }
          if (!sessionAllowedDirs.includes(target)) sessionAllowedDirs.push(target);
          ctx.ui.notify(`Authorized extra directory for this session: ${target.replaceAll('\\', '/')} (safe edits & 0-quota file preloading enabled).`, 'info');
        }
      });

      pi.registerCommand('remember', {
        description: 'Save a project rule into .copi/instructions.md at 0 web quota (usage: /remember <rule|--list>)',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim();
          if (!raw || raw === '--list' || raw === 'list') {
            const current = await readProjectRules(ctx.cwd);
            ctx.ui.notify(current.content
              ? `${current.path}:\n\n${current.content}`
              : `No rules saved in ${current.path} yet. Usage: /remember <rule>`, 'info');
            return;
          }
          const saved = await appendProjectRule(ctx.cwd, raw);
          if (!loadedInstructionFiles.includes('.copi/instructions.md')) {
            loadedInstructionFiles.push('.copi/instructions.md');
          }
          ctx.ui.notify(`Saved rule to ${saved.path} (0 quota):\n  ${saved.bullet}\nTakes effect automatically on new sessions and tab rotations.`, 'info');
        }
      });

      pi.registerCommand('logs', {
        description: 'Show recent Copi activity/diagnostic events (usage: /logs [count])',
        handler: async (args, ctx) => {
          const count = (args ?? '').trim() ? Number(args.trim()) : 20;
          const text = await formatRecentActivity(copiPaths, count);
          ctx.ui.notify(text, 'info');
        }
      });

      pi.registerCommand('undo', {
        description: 'Revert file edits made by Copi during the last agent turn',
        handler: async (args, ctx) => {
          const pending = undoManager.peekLastTurn();
          if (!pending) {
            ctx.ui.notify('No agent file edits recorded to undo in this session.', 'info');
            return;
          }
          const summary = pending.files.map(f => `  - ${f.action}: ${f.relPath}`).join('\n');
          const skipConfirm = /(?:^|\s)(?:--yes|-y)(?:\s|$)/.test(args ?? '');
          if (!skipConfirm && ctx.hasUI) {
            const ok = await ctx.ui.confirm(
              `Undo agent turn #${pending.turnNumber}?`,
              `This will revert the following file changes:\n\n${summary}\n\nProceed?`
            );
            if (!ok) {
              ctx.ui.notify('Undo cancelled.', 'info');
              return;
            }
          }
          const result = await undoManager.undoLastTurn();
          if (!result.undone) {
            ctx.ui.notify('Nothing to undo.', 'info');
            return;
          }
          ctx.ui.notify([
            `Reverted ${result.files.length} file(s) from turn #${result.turnNumber}:`,
            ...result.files.map(f => `  - ${f.action}: ${f.relPath}`)
          ].join('\n'), 'info');
        }
      });

      pi.registerCommand('readonly', {
        description: 'Toggle read-only exploration mode (disables write, edit, bash)',
        handler: async (args, ctx) => {
          const raw = (args ?? '').trim().toLowerCase();
          if (raw === 'on' || raw === '1' || raw === 'true') readonlyState.enabled = true;
          else if (raw === 'off' || raw === '0' || raw === 'false') readonlyState.enabled = false;
          else if (!raw) readonlyState.enabled = !readonlyState.enabled;
          else {
            ctx.ui.notify('Usage: /readonly [on|off]', 'warning');
            return;
          }
          if (typeof pi.setActiveTools === 'function') {
            pi.setActiveTools(readonlyState.enabled ? READONLY_TOOLS : ALL_TOOLS);
          }
          requestFooterRender();
          ctx.ui.notify(`Read-only mode: ${readonlyState.enabled ? 'ON (tools: read, grep, find)' : 'OFF (all tools enabled)'}.`, 'info');
        }
      });

      pi.registerCommand('doctor', {
        description: 'Run environment, Browser Host, quota, and M365 DOM selector diagnostics',
        handler: async (_args, ctx) => {
          const report = await runDoctor({ paths: copiPaths, browser });
          ctx.ui.notify(report.text, report.ok ? 'info' : 'warning');
        }
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

      // Built-in /copy and /export are handled directly by CopiInteractiveMode to avoid command conflicts.
      pi.registerCommand('copy-code', {
        description: 'Copy the last fenced code block from Copi\'s reply to the clipboard',
        handler: async (_args, ctx) => {
          const reply = getLastAssistantText();
          if (!reply || !reply.trim()) {
            ctx.ui.notify('No assistant reply available to copy yet.', 'warning');
            return;
          }
          const target = extractLastCodeBlock(reply);
          if (!target) {
            ctx.ui.notify('No fenced code block found in the last reply.', 'warning');
            return;
          }
          try {
            await copyToClipboard(target);
            ctx.ui.notify(`Copied last code block (${target.length} chars) to clipboard.`, 'info');
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
        description: 'Show session, quota, compaction, model, and Edge Browser Host status',
        handler: async (_args, ctx) => {
          const messageCount = getSessionMessageCount();
          const [liveStatus, quota] = await Promise.all([
            typeof browser?.getStatus === 'function' ? browser.getStatus().catch(() => null) : null,
            readTodayQuota(copiPaths)
          ]);
          updateQuotaRecord(quota);
          if (liveStatus?.state) {
            setEdgeState(liveStatus.state === 'waiting_signin' ? 'sign-in required' : liveStatus.state);
          }
          const sessionName = typeof pi.getSessionName === 'function' ? pi.getSessionName() : undefined;
          const modelPref = modelController ? formatModelPreference(modelController.getPreference()) : 'smart';
          const activeModel = liveStatus?.activeModel ?? modelController?.getLastSelectedLabel?.() ?? null;
          const pState = providerControl?.getState?.();
          const compactionNote = messageCount > PROACTIVE_COMPACTION_THRESHOLD
            ? `${messageCount} messages (proactive compaction active on resume/reconnect)`
            : `${messageCount}/${PROACTIVE_COMPACTION_THRESHOLD} messages before proactive compaction`;
          const versionNote = liveStatus?.hostVersion && CLI_VERSION && liveStatus.hostVersion !== CLI_VERSION
            ? ` · OUTDATED host v${liveStatus.hostVersion} vs CLI v${CLI_VERSION} (run "copi host stop")`
            : '';
          const hostDetail = liveStatus?.port ? ` (127.0.0.1:${liveStatus.port}, PID ${liveStatus.hostPid}${liveStatus.hostVersion ? `, v${liveStatus.hostVersion}` : ''})` : '';
          const tabDetail = pState?.webTurnsInTab
            ? ` · web tab: ${pState.webTurnsInTab} turns (~${(pState.webCharsInTab / 1000).toFixed(1)}K chars${pState.cachedReads ? `, ${pState.cachedReads} cached reads` : ''})`
            : '';
          ctx.ui.notify([
            `Workspace: ${ctx.cwd}`,
            `Session: ${sessionId ?? '(in-memory)'}${sessionName ? ` ("${sessionName}")` : ''}`,
            `Context: ${compactionNote}${tabDetail}`,
            `Quota: ${formatQuotaShort(quota)} (${quota.date})`,
            `Model: ${modelPref}${activeModel ? ` (active: ${activeModel})` : ''}`,
            `Edge: ${liveStatus?.state ?? edgeState}${hostDetail}${versionNote}${pState?.needsNewChat ? ' · web needs /reconnect or /new' : ''}`,
            `Mode: ${readonlyState.enabled ? 'read-only (read, grep, find)' : 'read-write'} · undo turns: ${undoManager.turnCount()}`,
            `Instructions: ${loadedInstructionFiles.length ? loadedInstructionFiles.join(', ') : '(none)'}`,
            ...(sessionAllowedDirs.length ? [`Allowed dirs: ${sessionAllowedDirs.map(d => d.replaceAll('\\', '/')).join(', ')}`] : []),
            ...(pendingRunContext ? [`Pending /run: "${pendingRunContext.command}" (exit ${pendingRunContext.exitCode}) — attaches to next prompt`] : []),
            `Prompts: ${promptTemplates.length ? promptTemplates.map(p => `/${p.name}`).join(', ') : '(none)'}`,
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
            `Tools: ${(readonlyState.enabled ? READONLY_TOOLS : ALL_TOOLS).join(', ')}`
          ].join('\n'), 'info');
        }
      });

      // Register built-in and user custom prompt templates (/review, /commit, /fix, ~/.copi/prompts/*.md).
      for (const template of promptTemplates) {
        pi.registerCommand(template.name, {
          description: `[${template.source}] ${template.description}`,
          handler: async (args, ctx) => {
            const rendered = await renderPromptTemplate(template, { args: args ?? '', cwd: ctx.cwd });
            const expanded = await expandFileMentions(rendered, ctx.cwd, { allowedDirs: sessionAllowedDirs });
            if (expanded.loadedEntries?.length) providerControl?.notePreloadedFiles?.(expanded.loadedEntries);
            const withRun = consumePendingRunContext(expanded.text);
            pi.sendUserMessage(withRun.text);
          }
        });
      }
    }
  };
}
