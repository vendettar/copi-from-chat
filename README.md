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
copi -C C:/path/to/project "inspect this project"
copi -p -C C:/path/to/project "run the tests"
```

On first use, sign in to Microsoft 365 in the Edge window.

Model selection uses index-based fallback (`last -> second-to-last -> first`) instead of hardcoded model names, so it stays compatible across Chinese/English M365 menus (such as `自动 / 快速响应 / 深度思考` or `Auto / Quick response / Think deeper`) and future model renames, falling back gracefully to the active/Auto model without failing the turn.

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

- `/new`: new conversation
- `/resume`: select a saved conversation
- `/web`: show workspace and tools
- `/quit`: exit

## Local data

- `sessions`: persisted Pi conversations
- `shared-browser-profile`: login state for the shared Edge window
- `browser-profiles`: optional isolated profiles used with `--profile`
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

Copy the generated `copi-from-chat-0.0.7.tgz` to the other computer, then install or upgrade it with Node.js 20 or newer (all runtime dependencies are bundled in the tarball for offline/restricted machines):

```bash
npm install -g --ignore-scripts ./copi-from-chat-0.0.7.tgz
copi --help
```

Before installing or upgrading, exit all running `copi` processes. Windows may otherwise lock Pi's native terminal module and cause an `EBUSY` installation error.

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
