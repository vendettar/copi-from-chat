# Copilot from Chat

Windows coding-agent CLI using Microsoft 365 Copilot in Edge as the model transport and Pi as the local agent runtime.

## Requirements

- Windows 10/11
- Node.js 20+ (Node.js 22.19+ recommended)
- Microsoft Edge
- Microsoft 365 access to https://m365.cloud.microsoft/chat
- Git for Windows (Git Bash)

## Install

```bash
npm install --ignore-scripts
npm link
copi --help
```

`copi` is standalone and does not depend on the original `copilot-from-chat` project.

## Usage

```bash
copi -C C:/path/to/project
copi -C C:/path/to/project "inspect @src/app.js and fix the crash"
copi -C C:/path/to/project --model quick
copi -C C:/path/to/project --readonly
git diff | copi -p -C C:/path/to/project "review these changes"
copi doctor
copi host status
copi host stop
copi sessions --all
```

Launching `copi` in interactive mode immediately opens the shared Edge window in the background so you can sign in to Microsoft 365 right away without waiting for your first message.

### Quota-Saver Engine & Model Selection (`/model`, `/think`, `/quota`)

M365 Copilot enforces a strict daily cap on `深度思考 / Think deeper`, while `快速响应 / Quick response` and `自动 / Auto` have much larger allowances. `copi` maximizes work per daily quota automatically:

- **`smart` mode (default)**: uses `深度思考 / Think deeper` on your main prompt and automatically steps down to `快速响应 / Quick response` for mechanical tool-result follow-ups. If M365 reports a `Think deeper` daily limit (in either a reply bubble or a page-level `[role="alert"]` / toast banner), Copi marks it for today in `~/.copi/quota.json`, switches to `quick`, and continues cleanly without crashing.
- **Ultra-lean wire payloads & adaptive rotation**: `continue` turns trim repeated protocol boilerplate by ~83%, `bootstrap` strips Pi harness `<docs>` and compacts tool schemas (~55% smaller), identical unchanged `read` calls within the same live tab are deduplicated on the wire, and long tabs auto-rotate cleanly by both turn count (25) and character budget (~60K chars).
- **Zero-turn local pre-context**: new conversations locally preload a compact workspace snapshot (branch, `git status`, manifest, file tree) and expand both explicit `@path/to/file[:start-end]` mentions and plain relative workspace file paths (plus piped `stdin`), eliminating exploratory `read` round-trips.
- **Sequential single-turn tool chaining, edit recovery & output denoising**: tool calls run sequentially in array order so Copilot can safely emit `[edit, bash("npm test")]` in **one** web turn (~33% fewer turns per edit); `grep` supports optional `context` lines (0–5) to inspect surrounding code without an extra `read` turn; failed `edit` calls automatically attach the closest current file lines locally; `bash` output strips ANSI codes, collapses `\r` progress bars, and folds duplicate lines before the 5K/10K budget; `write`/`edit` on `.js`/`.ts`/`.json`/`.py` files automatically attach a zero-quota local syntax check right in the tool result.
- **Zero-cost plain-text & trailing-comma recovery**: clean plain-text final answers are accepted locally without burning a `mode: 'repair'` quota turn.
- **One-shot `/think <prompt>`**: even when using `/model quick` or `/model auto`, run `/think <question>` to use `Think deeper` for a single turn and automatically return to your previous preference.
- **Index-based compatibility**: `/model` reads live options from Edge and matches by positional index (`smart`, `quick`, `auto`, `think`, or `0..N`), staying resilient across Chinese/English UI and future model renames.

## Resume conversations

Conversations are saved under `~/.copi/sessions`.

```bash
copi -C C:/path/to/project --continue
copi -C C:/path/to/project --session <session-id>
```

Use `/resume` in interactive mode. A resumed local session opens a fresh web conversation and sends a compact bootstrap context. Compaction is proactive after 12 messages, rather than waiting for an oversized browser payload; it keeps the initial task and recent turns while older messages are reduced to key decisions, paths, tool execution evidence, errors, and check results. During normal conversation only new messages are sent, and tool-result batches are proactively limited to about 10,000 JSON characters (about 5,000 per result), with full output saved locally when shortened. After clicking Send, Copi now waits up to 5 seconds for the editor to clear, generation to start, or the reply DOM to change; if the verified draft remains completely unchanged, it retries Send exactly once. Ambiguous page changes are never clicked again. User instructions are never shortened. The saved local JSONL transcript is never modified. This restores local coding context, not hidden Microsoft server-side state.

## Parallel windows

Every plain `copi` invocation creates a new local session and opens a dedicated tab in one shared Edge window. Multiple Git Bash tabs can run concurrently without extra arguments:

```bash
# Git Bash tab 1
copi -C C:/path/to/project
```

```bash
# Git Bash tab 2
copi -C C:/path/to/project
```

Use `/resume`, `--continue`, or `--session <id>` only when selecting an existing conversation. While the Browser Host remains running, resuming a session reuses its existing tab; otherwise it creates a new tab and restores the saved local context.

The shared login state is stored under `~/.copi/shared-browser-profile`. `--profile <name>` remains an escape hatch for launching a separate isolated Edge window.

## Interactive commands

- `/model [smart|quick|auto|think|<index>]`: read live models from Edge or switch model preference (`Ctrl+L`)
- `/think <prompt>`: run one prompt with `Think deeper`, then restore your previous preference
- `/quota`: show today's web turn breakdown (`think` / `quick` / `auto`) and quota-saving status
- `/undo [--yes]`: revert file changes made by Copi during the last agent turn
- `/readonly [on|off]`: toggle read-only exploration mode (`read`, `grep`, `find` only)
- `/inspect [N]`: open an interactive viewer for a specific tool call's full arguments and output
- `/review` · `/commit` · `/fix`: built-in prompt workflows (plus custom `~/.copi/prompts/*.md` and `.copi/prompts/*.md`)
- `/copy` · `/copy-code`: copy the last assistant reply (or last fenced code block) to the clipboard
- `/diff`: show `git status -s` and `git diff --stat` for the current workspace
- `/status`: show session info, daily quota, compaction progress, loaded instructions, model, and Edge Browser Host status
- `/doctor`: check Node, Git Bash, Edge, Browser Host, quota, and live M365 DOM selectors
- `/export [file.md]`: export the current session transcript to a Markdown report
- `/rename <name>`: set a display name for this saved session (shown in `/resume`)
- `/reconnect`: open a fresh Edge tab and restore saved local JSONL history on the next turn
- `/cleanup [days]`: prune old tool checkpoints and temporary saved tool outputs (default: 14 days)
- `/bell [on|off]`: toggle terminal completion bell for long responses
- `/new`: new conversation
- `/resume`: select a saved conversation
- `/web`: show workspace, browser mode, model preference, instructions, and tools
- `/quit`: exit

### Terminal UX, project instructions, and safety

- **Clear role headers**: user messages (`▌ You`) and agent replies (`▌ Copi <model>`) render with distinct visual headers without altering saved JSONL transcripts.
- **Compact tool folding**: `read`, `bash`, `edit`, `write`, `grep`, and `find` collapse to compact single-line summaries by default. Press **`Ctrl+O`** (or click a tool row) to expand/collapse full output and diffs, or use `/inspect` to inspect one specific call.
- **Project instructions**: `AGENTS.md`, `CLAUDE.md`, and `.copi/instructions.md` in the workspace are loaded automatically into the session prompt.
- **Safety confirmation**: destructive `bash` commands (such as `rm -rf`, `git reset --hard`, `git push --force`) and `write`/`edit` calls targeting paths outside the workspace require confirmation (pass `-y` / `--yes` to auto-approve).
- **Completion bell**: rings when long responses complete (disable with `--no-bell` or `/bell off`).

## Local data

- `sessions`: persisted Pi conversations
- `shared-browser-profile`: login state for the shared Edge window
- `browser-profiles`: optional isolated profiles used with `--profile`
- `config.json`: saved user preferences (default model mode, bell, optional `hostIdleMinutes`)
- `quota.json`: daily local web-turn counter by model tier (`think`/`quick`/`auto`)
- `prompts`: optional user custom slash-command prompt templates (`*.md`)
- `activity.jsonl`: lifecycle events
- `checkpoints`: tool-execution checkpoints
- `locks`: session, startup, and optional profile ownership locks
- `browser-host.json`: loopback Browser Host port and authentication token

These live under `~/.copi` and must not be committed.

## Recovery safety

The local JSONL session remains available if the web page refreshes or loses context. A failure proven to occur before Send can be retried in a fresh web conversation. A failure after Send is uncertain and must not be replayed automatically because it could repeat a command or file edit.

## Install on another Windows computer

Create the portable npm package on the source computer:

```bash
npm pack
```

Copy the generated `copi-from-chat-0.1.6.tgz` to the other computer, then install or upgrade it with Node.js 20 or newer:

```bash
npm install -g ./copi-from-chat-0.1.6.tgz
copi --help
```

Before installing or upgrading, stop any running `copi` processes (`copi host stop` stops the shared Browser Host cleanly). Windows may otherwise lock Pi's native terminal module and cause an `EBUSY` installation error.

### Command-line dependencies

`copi` exposes its own agent tools named `grep` and `find`. They are implemented with Git commands and do not require standalone `rg` or `fd` binaries.

`copi` does not bundle `jq` or general-purpose Unix command-line utilities. Bash commands run through Git Bash, so install any extra programs required by project scripts separately and ensure they are available on `PATH`.

Microsoft Edge and Git for Windows must already be installed. Run `copi` once and sign in to Microsoft 365 in the dedicated shared Edge window. Do not copy `~/.copi/shared-browser-profile` between computers because Microsoft Entra ID cookies and device-bound authentication may not remain valid. Session JSONL files under `~/.copi/sessions` may be copied if conversation history is needed.

## Development

```bash
npm test
npm run check
npm run browser
```

`npm run browser` requires interactive Microsoft 365 sign-in and is excluded from automated tests.

## Git rollback

```bash
git log --oneline
git diff 2bdf753..HEAD
git reset --hard 2bdf753
```

- `2bdf753`: original `copilot-from-chat-poc` implementation

## Known limitations

- Microsoft 365 DOM changes may break selectors.
- Post-Send failures cannot be retried safely without review.
- Very large restored sessions may exceed web/model context.
- Branching and history rewind within an existing web conversation remain disabled.
- Browser integration tests require a real Microsoft 365 account.

See `ROADMAP.md` for staged improvements and acceptance criteria.
