# Upgrade Summary

Summary of the transformation from `copilot-from-chat-poc` (`copilot`) to standalone `copi-from-chat` (`copi`).

## Package & CLI

- Renamed package from `copilot-from-chat-poc` (bin `copilot`) to `copi-from-chat` (bin `copi`), keeping `private: true` to prevent accidental `npm publish` while packaging cleanly via `npm pack` (`npm install -g ./copi-from-chat-0.1.0.tgz`).
- Added Quota-Saver Engine (`v0.1.0`): `smart` model tiering (`think` on main prompts, `quick` on tool-result follow-ups), one-shot `/think <prompt>`, daily turn tracking & automatic downgrade on `Think deeper` daily limit (`~/.copi/quota.json`), zero-turn workspace pre-context + `@file` preloading + piped `stdin`, aggressive multi-tool batching contract, zero-cost local JS/JSON post-edit syntax checks, zero-cost plain-text/trailing-comma final recovery, and proactive web tab rotation before M365 per-chat limits.
- Added `/undo` per-turn file snapshots, `--readonly` / `/readonly` exploration mode, custom prompt templates (`/review`, `/commit`, `/fix`, `~/.copi/prompts/*.md`, `.copi/prompts/*.md`), bounded non-Git fallback for `grep`/`find`, `/export` Markdown reports, `copi doctor` / `/doctor`, `copi host status|stop` (+ optional `hostIdleMinutes`), and `copi sessions`.
- Lowered `engines.node` to `>=20.0.0` and added `npm run check` (`src/check.js`).
- Added CLI flags `-c/--continue`, `-s/--session <id>`, `-m/--model <auto|quick|think|index>`, `-y/--yes`, `--no-bell`, `--profile <name>`, and `-v/--version`, plus Git Bash POSIX path normalization (`/c/...` -> `C:/...`) and extended Git Bash auto-detection on Windows.
- Interactive mode eagerly opens the shared Edge window on startup so Microsoft 365 login happens immediately and `/model` can inspect live webpage options right away.
- Added `/model` interactive selector and direct switching (`/model auto`, `/model quick`, `/model think`, `/model <index>`), persisted in `~/.copi/config.json`.
- Added distinct role headers (`▌ You` vs `▌ Copi <model>`), compact 1-line collapsed tool rendering (`Ctrl+O` / click to expand), `/inspect` single-tool detail viewer, and enriched footer status bar (`model`, `Edge`, `session`, `Ctrl+O`).
- Added automatic workspace instruction loading (`AGENTS.md`, `CLAUDE.md`, `.copi/instructions.md`), risky command & outside-workspace write confirmation guard (`--yes` to bypass), `/copy [code]` (UTF-8 safe on Windows PowerShell), `/diff`, `/status`, `/rename`, `/reconnect`, `/cleanup`, and `/bell`.

## Persisted Sessions, Resume & Proactive Compaction

- Replaced in-memory Pi sessions with persisted JSONL sessions stored under `~/.copi/sessions` (`PI_CODING_AGENT_DIR=~/.copi`).
- Enabled interactive `/resume` via Pi's session selector while keeping in-place branching, tree rewind, clone, and import disabled for web-session safety.
- Added deterministic proactive compaction (`src/compaction.js`) after 12 messages on bootstrap/resume payloads: preserves the initial task, all user instructions verbatim, and recent turns while summarizing older turns into key decisions, paths, tool execution evidence, errors, and check results without ever modifying the saved JSONL file.
- Lowered outgoing tool-result budgets in `src/tool-output.js` to ~10,000 JSON characters per batch and ~5,000 JSON characters per result, saving full original output locally whenever shortened.

## Parallel Windows & Shared Browser Host

- Added loopback HTTP Browser Host (`src/browser-host.js`) and client (`src/browser-client.js`) using `~/.copi/browser-host.json` (port + bearer token) and `~/.copi/shared-browser-profile`.
- Plain `copi` invocations now open dedicated tabs inside one shared Edge window with serialized UI-interaction locking (preventing keyboard focus collisions while streaming replies concurrently).
- Resuming a session via `/resume`, `--continue`, or `--session` reuses its existing tab while the Browser Host remains running; otherwise opens a new tab and restores compact local context.
- Added `--profile <name>` escape hatch for launching an isolated Edge window under `~/.copi/browser-profiles/<name>`.

## Send Reliability, Model Selector Compatibility, Recovery Safety & Local Observability

- Replaced brittle hardcoded model-name matching (`GPT-5.6 Sol Think deeper`) with index-based, non-fatal model selection (`last -> second-to-last -> first`, supporting Chinese/English menus such as `自动 / 快速响应 / 深度思考` and `Auto / Quick response / Think deeper`, renamed models, and nested submenus, and gracefully continuing with the current/Auto selection if unavailable).
- Upgraded `src/browser.js` Send confirmation: waits up to 5 seconds after clicking Send for editor clear, generation start, or reply DOM change; retries Send exactly once only if the verified draft remains completely unchanged; never re-clicks on ambiguous DOM changes.
- Separated proven pre-Send failures (safely retried once in a fresh web conversation using compact bootstrap context) from uncertain post-Send failures (never automatically replayed).
- Added `~/.copi/locks` (session, startup, and profile locks with stale-PID recovery), `~/.copi/checkpoints` (per-session tool start/end checkpoints), and `~/.copi/activity.jsonl` (lifecycle audit log).
