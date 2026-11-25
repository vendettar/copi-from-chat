#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { parseModelPreference } from './model-preference.js';
import { ensureCopiDirs, getCopiHome, getCopiPaths, normalizeCliPath, validateProfileName } from './paths.js';

const PACKAGE_JSON = new URL('../package.json', import.meta.url);

const HELP = `Copi · Copilot from Chat

Usage: copi [options] [prompt]

  No prompt               Open the interactive editor and launch Edge for sign-in
  [prompt]                Start a task and stay in the interactive session
  -p, --print             Run one task and exit (also used without a terminal)
  -C, --cwd <dir>         Start in a project directory
  -c, --continue          Resume the most recent saved session for this project
  -s, --session <id>      Resume a saved session by ID or JSONL file path
  -m, --model <target>    Web model preference: auto, quick, think, or 0-based menu index
  -y, --yes               Auto-approve risky bash commands and outside-workspace edits
  --no-bell               Disable completion bell for long responses
  --profile <name>        Launch a separate isolated Edge window (~/.copi/browser-profiles/<name>)
  -v, --version           Show version
  -h, --help              Show this help

Interactive commands:
  /model [auto|quick|think|N]   Read live models from Edge or switch preference
  /inspect [N]                  Inspect a specific tool call's full arguments & output
  /copy [code]                  Copy last assistant reply (or last code block) to clipboard
  /diff                         Show git status and diff summary for the workspace
  /status                       Show session, context, model, and Edge Browser Host status
  /rename <name>                Set a display name for this saved session (shown in /resume)
  /reconnect                    Open a fresh Edge tab and restore saved local history
  /cleanup [days]               Prune old checkpoints and saved temp tool outputs
  /bell [on|off]                Toggle completion bell for long responses
  /new, /resume, /web, /quit

Shortcuts: Enter submits · Shift+Enter newline · Esc stops · Ctrl+O toggles tool details · Ctrl+L /model
Conversations are saved under ~/.copi/sessions. Multiple Git Bash windows share one Edge window with dedicated tabs.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      print: { type: 'boolean', short: 'p' },
      cwd: { type: 'string', short: 'C' },
      continue: { type: 'boolean', short: 'c' },
      session: { type: 'string', short: 's' },
      model: { type: 'string', short: 'm' },
      yes: { type: 'boolean', short: 'y' },
      'no-bell': { type: 'boolean' },
      profile: { type: 'string' }
    }
  });

  if (values.help) {
    console.log(HELP);
  } else if (values.version) {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
    console.log(pkg.version);
  } else {
    if (values.continue && values.session) {
      throw new Error('Cannot use --continue and --session together.');
    }
    if (values.profile !== undefined) {
      validateProfileName(values.profile);
    }
    const modelPreference = values.model !== undefined ? parseModelPreference(values.model) : undefined;

    const prompt = positionals.join(' ').trim();
    const interactive = !values.print && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive && !prompt) {
      throw new Error('A prompt is required in print mode. Use a terminal for interactive mode.');
    }
    if (process.platform !== 'win32') {
      throw new Error('This CLI requires Windows.');
    }

    const installDir = fileURLToPath(new URL('..', import.meta.url));
    const npmLauncher = process.env.npm_lifecycle_event === 'start'
      && resolve(process.cwd()) === resolve(installDir);
    const rawCwd = values.cwd !== undefined
      ? normalizeCliPath(values.cwd)
      : (npmLauncher ? process.env.INIT_CWD : undefined) ?? process.cwd();
    const cwd = resolve(rawCwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);

    const copiHome = getCopiHome();
    const copiPaths = await ensureCopiDirs(getCopiPaths(copiHome));

    // Set before importing Pi so saved sessions and config live under ~/.copi.
    process.env.PI_CODING_AGENT_DIR = copiPaths.home;
    process.env.PI_OFFLINE = '1';

    const { resolveSessionManager, runAgent } = await import('./runtime.js');
    const { sessionManager, resumed } = await resolveSessionManager({
      cwd,
      continueRecent: Boolean(values.continue),
      sessionId: values.session,
      explicitCwd: values.cwd !== undefined
    });

    await runAgent({
      cwd: sessionManager.getCwd(),
      agentDir: copiPaths.home,
      copiPaths,
      sessionManager,
      resumed,
      profile: values.profile,
      modelPreference,
      autoApproveRisky: Boolean(values.yes),
      bell: values['no-bell'] ? false : undefined,
      prompt,
      interactive
    });
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode ||= 1;
}
