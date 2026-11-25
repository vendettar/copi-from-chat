import { accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { Container, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  InteractiveMode, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { CopilotBrowser } from './browser.js';
import { SharedBrowserClient } from './browser-client.js';
import { loadProjectInstructions } from './instructions.js';
import {
  DEFAULT_MODEL_PREFERENCE, formatModelPreference, getBuiltinModelPresets,
  parseModelPreference, presetAliasForIndex
} from './model-preference.js';
import { createCopilotProvider } from './pi-provider.js';
import { createWebUI } from './web-ui.js';
import { createSearchTools } from './search-tools.js';
import {
  acquireProfileLock, acquireSessionLock, logActivity,
  readConfig, readIncompleteCheckpoints, saveConfig
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

const SELECT_THEME = {
  selectedPrefix: text => `\x1b[36m${text}\x1b[0m`,
  selectedText: text => `\x1b[1;36m${text}\x1b[0m`,
  description: text => `\x1b[2m${text}\x1b[0m`,
  scrollInfo: text => `\x1b[2m${text}\x1b[0m`,
  noMatch: text => `\x1b[33m${text}\x1b[0m`
};

export function createModelController({ copiPaths, initialPreference = DEFAULT_MODEL_PREFERENCE } = {}) {
  let preference = parseModelPreference(initialPreference);
  let activeBrowser = null;
  let lastSelectedLabel = null;
  const listeners = new Set();

  const notifyChange = () => {
    for (const fn of listeners) {
      try { fn(preference); } catch { /* ignore */ }
    }
  };

  return {
    getPreference: () => preference,
    getLastSelectedLabel: () => activeBrowser?.lastSelectedModel ?? lastSelectedLabel,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    attachBrowser(browser) {
      activeBrowser = browser;
      if (browser && 'modelPreference' in browser) {
        try { browser.modelPreference = preference; } catch { /* mock browser */ }
      }
    },
    async listModels({ openIfNeeded = false } = {}) {
      if (typeof activeBrowser?.listModels !== 'function') {
        return { ready: false, current: lastSelectedLabel, models: [], reason: 'unsupported' };
      }
      const data = await activeBrowser.listModels({ openIfNeeded });
      if (data?.current) lastSelectedLabel = data.current;
      return data;
    },
    async setPreference(input, { applyNow = true, persist = true } = {}) {
      const parsed = parseModelPreference(input);
      preference = parsed;
      if (persist && copiPaths) {
        await saveConfig(copiPaths, { modelPreference: formatModelPreference(parsed) }).catch(() => {});
      }
      let applied = false;
      let result = null;
      if (typeof activeBrowser?.setModelPreference === 'function') {
        const response = await activeBrowser.setModelPreference(parsed, { applyNow });
        applied = Boolean(response?.applied);
        result = response?.result ?? null;
        if (result?.label) lastSelectedLabel = result.label;
      }
      notifyChange();
      return { preference: parsed, applied, result };
    }
  };
}

// Keep /resume enabled via Pi's SessionSelectorComponent and take over /model for M365 web model selection,
// while blocking in-place branching/rewind that cannot rewind a live M365 web conversation.
class CopiInteractiveMode extends InteractiveMode {
  constructor(runtime, options = {}) {
    const { modelController, ...superOptions } = options;
    super(runtime, superOptions);
    this.modelController = modelController;
  }

  async _applyModelChoice(input) {
    try {
      const { preference, applied, result } = await this.modelController.setPreference(input, { applyNow: true, persist: true });
      const prefText = formatModelPreference(preference);
      if (applied && result?.label) {
        const idx = result.index !== undefined ? `[${result.index}] ` : '';
        this.showStatus(`Web model switched to ${idx}${result.label} (${prefText})`);
      } else {
        this.showStatus(`Web model preference set to "${prefText}" (will apply once Edge chat is ready)`);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  async handleModelCommand(searchTerm) {
    if (!this.modelController) {
      this.showWarning('Web model selector is unavailable in this session.');
      return;
    }
    const arg = (searchTerm ?? '').trim();
    if (!arg || arg === 'list' || arg === 'ls') {
      await this.showModelSelector();
      return;
    }
    await this._applyModelChoice(arg);
  }

  async showModelSelector() {
    if (!this.modelController) {
      this.showWarning('Web model selector is unavailable in this session.');
      return;
    }
    this.showStatus('Reading models from Edge...');
    const live = await this.modelController.listModels({ openIfNeeded: false }).catch(() => ({
      ready: false, current: null, models: [], reason: 'read_error'
    }));
    const currentPref = formatModelPreference(this.modelController.getPreference());

    let headerText;
    let items;
    let initialIndex = 0;

    if (live.ready && Array.isArray(live.models) && live.models.length > 0) {
      headerText = `Web models (live from Edge · preference: ${currentPref})`;
      items = live.models.map(item => {
        const alias = presetAliasForIndex(item.index, live.models.length);
        const meta = [
          alias ? `alias: ${alias}` : '',
          item.selected ? 'current' : '',
          item.description
        ].filter(Boolean).join(' · ');
        return {
          value: String(item.index),
          label: `[${item.index}] ${item.label}`,
          description: meta || undefined
        };
      });
      const currentIdx = live.models.findIndex(item => item.selected);
      if (currentIdx >= 0) initialIndex = currentIdx;
    } else {
      const reasonHint = live.reason === 'not_signed_in'
        ? 'Sign in to Microsoft 365 in Edge, then run /model again to see the live list.'
        : live.reason === 'busy'
          ? 'Edge tab is busy; select a preset for the next turn.'
          : 'Edge chat is still loading; pick a preset now (applies automatically once ready).';
      headerText = `Web model presets (current preference: ${currentPref}) — ${reasonHint}`;
      items = getBuiltinModelPresets();
      const presetIdx = items.findIndex(item => item.value === currentPref);
      if (presetIdx >= 0) initialIndex = presetIdx;
    }

    this.showSelector(done => {
      const container = new Container();
      container.addChild(new Text(`\x1b[1m${headerText}\x1b[0m`, 0, 0));
      container.addChild(new Spacer(1));
      const list = new SelectList(items, Math.min(8, Math.max(1, items.length)), SELECT_THEME);
      list.setSelectedIndex(initialIndex);
      list.onSelect = item => {
        done();
        this.ui.requestRender();
        void this._applyModelChoice(item.value);
      };
      list.onCancel = () => {
        done();
        this.ui.requestRender();
      };
      container.addChild(list);
      container.addChild(new Text('\x1b[2mUse ↑/↓ + Enter to choose, Esc to cancel, or /model auto|quick|think|<index>\x1b[0m', 0, 0));
      return { component: container, focus: list };
    });
  }

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
  modelController,
  prewarmBrowser = false,
  autoApproveRisky = false,
  bellState,
  sharedBrowserOptions
}) {
  const sessionId = sessionManager.getSessionId();
  let sessionLock = null;
  if (copiPaths && sessionManager.isPersisted()) {
    sessionLock = await acquireSessionLock(copiPaths, sessionId);
  }

  const initialModelPref = modelController?.getPreference() ?? DEFAULT_MODEL_PREFERENCE;
  const activeBrowser = browser ?? (profile
    ? new CopilotBrowser({
      profileDir: copiPaths.profileDir(profile),
      diagnosticPath: copiPaths.inputDiagnosticFile,
      modelPreference: initialModelPref
    })
    : new SharedBrowserClient({
      paths: copiPaths,
      sessionId,
      modelPreference: initialModelPref,
      ...sharedBrowserOptions
    }));

  modelController?.attachBrowser(activeBrowser);

  const projectInstructions = await loadProjectInstructions(cwd);
  const providerControl = {};
  let sessionRef = null;
  const webUI = createWebUI(activeBrowser, {
    copiPaths,
    sessionId,
    profile,
    sessionLock,
    modelController,
    providerControl,
    loadedInstructionFiles: projectInstructions.files,
    autoApproveRisky,
    bellState,
    getSessionMessages: () => sessionRef?.messages ?? [],
    getLastAssistantText: () => sessionRef?.getLastAssistantText?.(),
    getSessionMessageCount: () => sessionRef?.messages?.length ?? 0
  });
  const unsubModel = modelController?.onChange?.(() => webUI.requestFooterRender());

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
      getIncompleteCheckpoints: id => readIncompleteCheckpoints(copiPaths, id),
      control: providerControl
    }));
    const appendSystemPrompt = [
      'Use Bash syntax and forward-slash paths on Windows. ' +
      'Use grep and find to search project files; use bash for commands, builds and tests. ' +
      'Keep tool output focused: read files with offset/limit and bound command output. Inspect large files in sections.'
    ];
    if (projectInstructions.promptSection) {
      appendSystemPrompt.push(projectInstructions.promptSection);
    }
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true, disabledBuiltinExtensions: ['mcp'], extensionFactories: [webUI.extension],
        noSkills: true, noPromptTemplates: true, noThemes: true,
        appendSystemPrompt
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
        existingMessages: sessionRef.messages.length,
        instructions: projectInstructions.files
      });
    }

    // In interactive mode, immediately open Edge in the background so the user can sign in right away
    // and /model can read the live webpage options without waiting for the first prompt.
    if (prewarmBrowser && typeof activeBrowser?.warm === 'function') {
      webUI.setEdgeState('connecting');
      void activeBrowser.warm({ wait: false, onStatus: webUI.onStatus })
        .then(res => {
          webUI.setEdgeState(res?.ready ? 'ready' : 'sign-in required');
        })
        .catch(error => {
          webUI.setEdgeState('offline');
          void logActivity(copiPaths, 'browser_warm_error', { sessionId, message: error?.message ?? String(error) });
        });
    }

    return {
      ...created,
      services, diagnostics: services.diagnostics
    };
  } catch (error) {
    unsubModel?.();
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
  modelPreference,
  autoApproveRisky = false,
  bell,
  prompt,
  interactive,
  browser,
  sharedBrowserOptions
}) {
  let profileLock = null;
  if (profile && copiPaths) {
    profileLock = await acquireProfileLock(copiPaths, profile);
  }

  const savedConfig = copiPaths ? await readConfig(copiPaths) : {};
  let initialPreference = modelPreference;
  if (initialPreference === undefined && savedConfig.modelPreference !== undefined) {
    try { initialPreference = parseModelPreference(savedConfig.modelPreference); } catch { /* ignore invalid saved value */ }
  }
  const modelController = createModelController({ copiPaths, initialPreference });
  const bellEnabled = bell !== undefined ? Boolean(bell) : savedConfig.bell !== false;
  const bellState = { enabled: bellEnabled, minMs: 5000 };
  const effectiveAutoApprove = autoApproveRisky || savedConfig.confirmRiskyTools === false;

  let runtime;
  let mode;
  const interrupt = () => { process.exitCode = 130; void runtime?.session.abort(); };

  try {
    const factory = options => createRuntime({
      ...options,
      browser,
      copiPaths,
      profile,
      modelController,
      prewarmBrowser: Boolean(interactive),
      autoApproveRisky: effectiveAutoApprove,
      bellState,
      sharedBrowserOptions
    });
    runtime = await createAgentSessionRuntime(factory, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
      sessionStartEvent: { type: 'session_start', reason: resumed ? 'resume' : 'startup' }
    });

    if (interactive) {
      mode = new CopiInteractiveMode(runtime, {
        initialMessage: prompt || undefined,
        modelController
      });
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
