#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { getBrowserHostHealth, stopBrowserHost } from './browser-client.js';
import { parseModelPreference } from './model-preference.js';
import { ensureCopiDirs, getCopiHome, getCopiPaths, normalizeCliPath, validateProfileName } from './paths.js';

const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const MAX_STDIN_CHARS = 32000;

const HELP = `Copi · Copilot from Chat

Usage:
  copi [options] [prompt]
  copi upgrade [--check]
  copi doctor
  copi logs [N]
  copi host <status|stop>
  copi sessions [--all] [-C <dir>]

Options:
  No prompt               Open the interactive editor and launch Edge for sign-in
  [prompt]                Start a task and stay in the interactive session (supports @file & piped stdin)
  -p, --print             Run one task and exit (also used automatically when stdin/stdout is piped)
  -C, --cwd <dir>         Start in a project directory
  --add-dir <dir>         Authorize an extra directory for edits & 0-quota preloading (repeatable)
  -c, --continue          Resume the most recent saved session for this project
  -s, --session <id>      Resume a saved session by ID or JSONL file path
  -m, --model <target>    Model mode: smart (default), quick, auto, think, or 0-based menu index
  --readonly              Read-only exploration mode (disables write, edit, and bash)
  --no-preload            Disable zero-turn local workspace snapshot preloading
  -y, --yes               Auto-approve risky bash commands and outside-workspace edits
  --no-bell               Disable completion bell for long responses
  --profile <name>        Launch a separate isolated Edge window (~/.copi/browser-profiles/<name>)
  -v, --version           Show version
  -h, --help              Show this help

Interactive commands:
  /model [smart|quick|auto|think|N]  Read live models from Edge or switch preference
  /think <prompt>                    Run one prompt with Think deeper, then restore previous preference
  /run <command>                     Run a local command at 0 quota & auto-attach output to next prompt
  /allow-dir [dir|clear]             Authorize an extra directory for safe edits & 0-quota preloading
  /remember <rule|--list>            Save a project rule to .copi/instructions.md at 0 quota
  /logs [N]                          Show recent Copi activity & diagnostic events
  /quota                             Show today's web turns by model tier and quota tips
  /undo [--yes]                      Revert file changes made during the last agent turn
  /readonly [on|off]                 Toggle read-only exploration mode
  /inspect [N]                       Inspect a specific tool call's full arguments & output
  /review | /commit | /fix           Built-in prompt workflows (+ custom ~/.copi/prompts/*.md)
  /copy                              Copy last assistant reply to clipboard (/copy-code for last code block)
  /diff                              Show git status and diff summary for the workspace
  /status                            Show session, quota, compaction, model, and Edge status
  /doctor                            Check environment, Browser Host, quota, and DOM selectors
  /export [file.md]                  Export conversation transcript to Markdown
  /rename <name>                     Set a display name for this saved session (shown in /resume)
  /reconnect                         Open a fresh Edge tab and restore saved local history
  /cleanup [days]                    Prune old checkpoints and saved temp tool outputs
  /bell [on|off]                     Toggle completion bell for long responses
  /new, /resume, /web, /quit

Shortcuts: Enter submits · Shift+Enter newline · Esc stops · Ctrl+O toggles tool details · Ctrl+L /model
Tip: Pipe stdin in print mode, e.g. \`git diff | copi -p "review these changes"\`.
`;

async function readPipedStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolveStdin, rejectStdin) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('error', rejectStdin);
    process.stdin.on('end', () => {
      const raw = chunks.join('').trim();
      if (raw.length <= MAX_STDIN_CHARS) return resolveStdin(raw);
      const head = raw.slice(0, Math.floor(MAX_STDIN_CHARS * 0.7));
      const tail = raw.slice(-Math.floor(MAX_STDIN_CHARS * 0.25));
      resolveStdin(`${head}\n\n[... piped stdin middle omitted (${raw.length} chars total) ...]\n\n${tail}`);
    });
    process.stdin.resume();
  });
}

function resolveTargetCwd(cwdFlag) {
  const installDir = fileURLToPath(new URL('..', import.meta.url));
  const npmLauncher = process.env.npm_lifecycle_event === 'start'
    && resolve(process.cwd()) === resolve(installDir);
  const rawCwd = cwdFlag !== undefined
    ? normalizeCliPath(cwdFlag)
    : (npmLauncher ? process.env.INIT_CWD : undefined) ?? process.cwd();
  return resolve(rawCwd);
}

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
      readonly: { type: 'boolean' },
      'no-preload': { type: 'boolean' },
      'add-dir': { type: 'string', multiple: true },
      check: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-bell': { type: 'boolean' },
      all: { type: 'boolean', short: 'a' },
      profile: { type: 'string' }
    }
  });

  if (values.help) {
    console.log(HELP);
  } else if (values.version) {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
    console.log(pkg.version);
  } else if (!values.print && positionals[0] === 'upgrade' && positionals.length === 1) {
    const copiPaths = getCopiPaths(getCopiHome());
    const { runUpgrade } = await import('./upgrade.js');
    await runUpgrade({ paths: copiPaths, checkOnly: Boolean(values.check) });
  } else if (!values.print && positionals[0] === 'logs' && positionals.length <= 2) {
    const copiPaths = getCopiPaths(getCopiHome());
    const { formatRecentActivity } = await import('./commands.js');
    const count = positionals[1] ? Number(positionals[1]) : 20;
    console.log(await formatRecentActivity(copiPaths, count));
  } else if (!values.print && positionals[0] === 'doctor' && positionals.length === 1) {
    const copiPaths = getCopiPaths(getCopiHome());
    const { runDoctor } = await import('./doctor.js');
    const report = await runDoctor({ paths: copiPaths });
    console.log(report.text);
    if (!report.ok) process.exitCode = 1;
  } else if (!values.print && positionals[0] === 'host') {
    const sub = positionals[1] ?? 'status';
    const copiPaths = getCopiPaths(getCopiHome());
    if (sub === 'status') {
      const host = await getBrowserHostHealth(copiPaths);
      if (host.running) {
        console.log(`Browser Host running on 127.0.0.1:${host.descriptor.port} (PID ${host.descriptor.pid}, tabs: ${host.health.tabs?.length ?? 0}).`);
      } else {
        console.log('Browser Host is not running.');
      }
    } else if (sub === 'stop') {
      const res = await stopBrowserHost(copiPaths);
      console.log(res.stopped ? `Stopped Browser Host (PID ${res.pid}).` : 'Browser Host was not running.');
    } else {
      throw new Error(`Unknown host action "${sub}". Use "copi host status" or "copi host stop".`);
    }
  } else if (!values.print && positionals[0] === 'sessions' && positionals.length === 1) {
    const copiPaths = await ensureCopiDirs(getCopiPaths(getCopiHome()));
    process.env.PI_CODING_AGENT_DIR = copiPaths.home;
    process.env.PI_OFFLINE = '1';
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const cwd = resolveTargetCwd(values.cwd);
    const list = values.all ? await SessionManager.listAll() : await SessionManager.list(cwd);
    if (!list.length) {
      console.log(values.all ? 'No saved sessions found.' : `No saved sessions found for ${cwd}. Try "copi sessions --all".`);
    } else {
      for (const s of list.slice(0, 30)) {
        const stamp = s.modified.toISOString().replace('T', ' ').slice(0, 16);
        const name = s.name ? ` [${s.name}]` : '';
        const preview = (s.firstMessage || '').replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${s.id.slice(0, 12)}  ${stamp}  ${String(s.messageCount).padStart(3)} msgs${name}  ${preview}`);
      }
    }
  } else {
    if (values.continue && values.session) {
      throw new Error('Cannot use --continue and --session together.');
    }
    if (values.profile !== undefined) {
      validateProfileName(values.profile);
    }
    const modelPreference = values.model !== undefined ? parseModelPreference(values.model) : undefined;

    const rawPrompt = positionals.join(' ').trim();
    const interactive = !values.print && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const pipedStdin = !interactive ? await readPipedStdin() : '';
    const prompt = pipedStdin
      ? (rawPrompt ? `${rawPrompt}\n\n[Piped stdin]\n${pipedStdin}` : pipedStdin)
      : rawPrompt;

    if (!interactive && !prompt) {
      throw new Error('A prompt (or piped stdin) is required in print mode. Use a terminal for interactive mode.');
    }
    if (process.platform !== 'win32') {
      throw new Error('This CLI requires Windows.');
    }

    const cwd = resolveTargetCwd(values.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    const allowedDirs = [];
    for (const rawDir of values['add-dir'] ?? []) {
      const resolvedDir = resolve(cwd, normalizeCliPath(rawDir));
      if (!(await stat(resolvedDir)).isDirectory()) throw new Error(`--add-dir is not a directory: ${resolvedDir}`);
      allowedDirs.push(resolvedDir);
    }

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
      readonly: Boolean(values.readonly),
      preloadWorkspace: !values['no-preload'],
      allowedDirs,
      bell: values['no-bell'] ? false : undefined,
      prompt,
      interactive
    });
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode ||= 1;
}
