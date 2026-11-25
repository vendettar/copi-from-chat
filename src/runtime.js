import { accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  InteractiveMode, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { CopilotBrowser } from './browser.js';
import { SharedBrowserClient } from './browser-client.js';
import { createCopilotProvider } from './pi-provider.js';
import { createWebUI } from './web-ui.js';
import { createSearchTools } from './search-tools.js';
import {
  acquireProfileLock, acquireSessionLock, logActivity, readIncompleteCheckpoints
} from './storage.js';

function pathAccessible(filePath) {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveShellPath(env = process.env, platform = process.platform) {
  const explicit = env.COPI_BASH_PATH || env.COPILOT_BASH_PATH;
  if (explicit) return explicit;
  if (platform !== 'win32') return undefined;

  const candidates = [];
  if (env.EXEPATH) candidates.push(join(env.EXEPATH, 'bin', 'bash.exe'));
  if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));

  for (const candidate of candidates) {
    if (pathAccessible(candidate)) return candidate;
  }
  return undefined;
}

// Keep /resume enabled via Pi's SessionSelectorComponent while blocking in-place branching/rewind
// that cannot rewind a live M365 web conversation.
class CopiInteractiveMode extends InteractiveMode {
  async handleImportCommand() { this.showWarning('Session import is disabled. Use /resume or /new.'); }
  showUserMessageSelector() { this.showWarning('Session branching within an existing web conversation is disabled. Use /new or /resume.'); }
  showTreeSelector() { this.showWarning('History rewind within an existing web conversation is disabled. Use /new or /resume.'); }
  async handleCloneCommand() { this.showWarning('Session cloning is unavailable. Use /new or /resume.'); }
}

export async function resolveSessionManager({
  cwd,
  continueRecent = false,
  sessionId,
  explicitCwd = false,
  sessionDir
} = {}) {
  if (continueRecent && sessionId) {
    throw new Error('Cannot combine --continue and --session.');
  }

  if (!continueRecent && !sessionId) {
    return {
      sessionManager: SessionManager.create(cwd, sessionDir),
      resumed: false
    };
  }

  if (continueRecent) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    if (!sessions.length) {
      throw new Error(`No saved session found for ${cwd}. Run copi without --continue to start a new session.`);
    }
    return {
      sessionManager: SessionManager.open(sessions[0].path, sessionDir),
      resumed: true
    };
  }

  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error('--session requires a session ID or JSONL file path.');

  if (trimmed.endsWith('.jsonl') && pathAccessible(resolve(trimmed))) {
    return {
      sessionManager: SessionManager.open(resolve(trimmed), sessionDir, explicitCwd ? cwd : undefined),
      resumed: true
    };
  }

  const exactInCwd = SessionManager.findById(cwd, trimmed, sessionDir);
  if (exactInCwd) {
    return {
      sessionManager: SessionManager.open(exactInCwd, sessionDir),
      resumed: true
    };
  }

  const inCwd = await SessionManager.list(cwd, sessionDir);
  const cwdPrefix = inCwd.filter(item => item.id.startsWith(trimmed));
  if (cwdPrefix.length === 1) {
    return {
      sessionManager: SessionManager.open(cwdPrefix[0].path, sessionDir),
      resumed: true
    };
  }
  if (cwdPrefix.length > 1) {
    throw new Error(`Ambiguous session prefix "${trimmed}" (${cwdPrefix.slice(0, 5).map(s => s.id).join(', ')}). Provide a longer ID.`);
  }

  const all = sessionDir ? await SessionManager.listAll(sessionDir) : await SessionManager.listAll();
  const exactAll = all.filter(item => item.id === trimmed);
  if (exactAll.length === 1) {
    return {
      sessionManager: SessionManager.open(exactAll[0].path, sessionDir, explicitCwd ? cwd : undefined),
      resumed: true
    };
  }
  const prefixAll = all.filter(item => item.id.startsWith(trimmed));
  if (prefixAll.length === 1) {
    return {
      sessionManager: SessionManager.open(prefixAll[0].path, sessionDir, explicitCwd ? cwd : undefined),
      resumed: true
    };
  }
  if (prefixAll.length > 1) {
    throw new Error(`Ambiguous session prefix "${trimmed}" (${prefixAll.slice(0, 5).map(s => s.id).join(', ')}). Provide a longer ID.`);
  }

  throw new Error(`Saved session not found: ${trimmed}`);
}

export async function createRuntime({
  cwd,
  agentDir,
  sessionManager,
  sessionStartEvent,
  browser,
  copiPaths,
  profile,
  sharedBrowserOptions
}) {
  const sessionId = sessionManager.getSessionId();
  let sessionLock = null;
  if (copiPaths && sessionManager.isPersisted()) {
    sessionLock = await acquireSessionLock(copiPaths, sessionId);
  }

  const activeBrowser = browser ?? (profile
    ? new CopilotBrowser({
      profileDir: copiPaths.profileDir(profile),
      diagnosticPath: copiPaths.inputDiagnosticFile
    })
    : new SharedBrowserClient({
      paths: copiPaths,
      sessionId,
      ...sharedBrowserOptions
    }));

  let sessionRef = null;
  const webUI = createWebUI(activeBrowser, {
    copiPaths,
    sessionId,
    profile,
    sessionLock,
    getSessionMessageCount: () => sessionRef?.messages?.length ?? 0
  });

  try {
    const settingsManager = SettingsManager.inMemory({
      // Let Git Bash's terminal own mouse scrolling and scrollback.
      tuiMode: 'regular',
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
      branchSummary: { skipPrompt: true }, quietStartup: true,
      enableInstallTelemetry: false, enableAnalytics: false, showCacheMissNotices: false,
      images: { blockImages: true }, shellPath: resolveShellPath()
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false
    });
    modelRuntime.registerNativeProvider(createCopilotProvider(activeBrowser, {
      onStatus: webUI.onStatus,
      onActivity: (event, data) => logActivity(copiPaths, event, data),
      getIncompleteCheckpoints: id => readIncompleteCheckpoints(copiPaths, id)
    }));
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true, disabledBuiltinExtensions: ['mcp'], extensionFactories: [webUI.extension],
        noSkills: true, noPromptTemplates: true, noThemes: true,
        appendSystemPrompt: [
          'Use Bash syntax and forward-slash paths on Windows. ' +
          'Use grep and find to search project files; use bash for commands, builds and tests. ' +
          'Keep tool output focused: read files with offset/limit and bound command output. Inspect large files in sections.'
        ]
      }
    });
    const created = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: modelRuntime.getModel('copilot-web', 'm365-web'), thinkingLevel: 'off',
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find'], customTools: createSearchTools(cwd)
    });
    sessionRef = created.session;

    if (copiPaths) {
      const reason = sessionStartEvent?.reason ?? (sessionRef.messages.length > 0 ? 'resume' : 'new');
      await logActivity(copiPaths, reason === 'resume' ? 'session_resume' : 'session_start', {
        sessionId,
        cwd,
        profile: profile ?? null,
        existingMessages: sessionRef.messages.length
      });
    }

    return {
      ...created,
      services, diagnostics: services.diagnostics
    };
  } catch (error) {
    await sessionLock?.release();
    throw error;
  }
}

export async function runAgent({
  cwd,
  agentDir,
  copiPaths,
  sessionManager,
  resumed = false,
  profile,
  prompt,
  interactive,
  browser,
  sharedBrowserOptions
}) {
  let profileLock = null;
  if (profile && copiPaths) {
    profileLock = await acquireProfileLock(copiPaths, profile);
  }

  let runtime;
  let mode;
  const interrupt = () => { process.exitCode = 130; void runtime?.session.abort(); };

  try {
    const factory = options => createRuntime({
      ...options,
      browser,
      copiPaths,
      profile,
      sharedBrowserOptions
    });
    runtime = await createAgentSessionRuntime(factory, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
      sessionStartEvent: { type: 'session_start', reason: resumed ? 'resume' : 'startup' }
    });

    if (interactive) {
      mode = new CopiInteractiveMode(runtime, { initialMessage: prompt || undefined });
      await mode.run();
    } else {
      const session = runtime.session;
      await session.bindExtensions({});
      session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        if (event.type === 'tool_execution_start') console.error(`[tool] ${event.toolName}`);
        if (event.type === 'tool_execution_end' && event.isError) console.error(`[tool] ${event.toolName} failed`);
      });
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
      await session.prompt(prompt);
      const last = session.state.messages.findLast(message => message.role === 'assistant');
      if (process.exitCode !== 130 && (!last || last.stopReason !== 'stop')) {
        throw new Error(last?.errorMessage ?? 'The task did not complete.');
      }
      process.stdout.write('\n');
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    mode?.stop();
    if (runtime) await runtime.dispose();
    await profileLock?.release();
  }
}
