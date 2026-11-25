# Roadmap

Staged improvements and acceptance criteria for `copi-from-chat`.

## Stage 1 — Persisted Local Sessions & Resume (Completed)

- Persist Pi conversation transcripts as append-only JSONL files under `~/.copi/sessions`.
- Support `--continue`, `--session <id>`, and interactive `/resume` in Git Bash on Windows.
- Preserve saved JSONL transcripts unmodified during resume and compaction.
- Protect open sessions with ownership locks under `~/.copi/locks` and stale-PID recovery.
- **Acceptance criteria**: Sessions survive CLI restart, can be resumed by `--continue`, `--session`, or `/resume`, and refuse concurrent mutation by two `copi` processes on the same session ID.

## Stage 2 — Proactive Compaction & Tool-Output Budgeting (Completed)

- Trigger proactive bootstrap compaction whenever a restored session exceeds 12 messages.
- Keep the initial task, all user instructions verbatim, and recent turns intact while summarizing older turns into key decisions, paths, tool execution evidence, errors, and check results.
- Enforce proactive outgoing tool-result limits (~10,000 JSON characters per batch, ~5,000 per result) while saving full original output locally for `read`/`bash` follow-up.
- **Acceptance criteria**: Resumed conversations over 12 messages compact without modifying JSONL history, never truncate user instructions, and keep tool-result batches within budget.

## Stage 3 — Shared Browser Host & Parallel Git Bash Windows (Completed)

- Run a loopback HTTP Browser Host (`~/.copi/browser-host.json` with random bearer token) owning one shared Edge window (`~/.copi/shared-browser-profile`).
- Allocate one dedicated Edge tab per `copi` session so multiple Git Bash tabs run concurrently without extra arguments.
- Reuse an existing live tab when resuming a session while the Browser Host remains running; open a fresh tab and restore local context otherwise.
- Retain `--profile <name>` with profile ownership locks as an isolated-window escape hatch.
- **Acceptance criteria**: Multiple concurrent `copi` sessions share one Edge window without profile collisions or keyboard-focus races; resuming reuses the active tab when available.

## Stage 4 — Send Confirmation, Recovery Safety & Portable `.tgz` Distribution (Completed)

- Wait up to 5 seconds after clicking Send for editor clear, generation start, or reply DOM change; retry Send exactly once only if the verified draft stays completely unchanged; never click again on ambiguous DOM changes.
- Retry proven pre-Send failures (such as lost web context or unchanged draft after retry) in a fresh web conversation; block automatic replay on uncertain post-Send failures.
- Record lifecycle events in `~/.copi/activity.jsonl` and tool checkpoints in `~/.copi/checkpoints`.
- Package `copi-from-chat` via `npm pack` with bundled dependencies for offline global installation on Windows.
- **Acceptance criteria**: Send retry triggers at most once when draft is unchanged, never retries on ambiguous DOM change or post-Send failure, and `npm install -g ./copi-from-chat-*.tgz` installs `copi` offline.

## Stage 5 — Future Hardening (Planned)

- Optional `copi sessions` list/prune subcommand for managing old transcripts and checkpoints.
- Configurable model selector target via environment variable or CLI flag if M365 renames model labels.
- Optional Browser Host idle shutdown timer after all tabs are closed.
- Exportable diagnostic bundle (redacting chat prose) for troubleshooting M365 DOM selector drift.
