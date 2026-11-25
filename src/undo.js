import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

// Tracks pre-edit file states grouped by agent turn so /undo can cleanly roll back
// ONLY the last agent turn's file writes/edits without touching Git staging or manual edits.
export function createUndoManager(cwd, { maxTurns = 15 } = {}) {
  const root = resolve(cwd);
  const turns = [];
  let currentTurn = null;

  const beginTurn = () => {
    currentTurn = {
      turnNumber: turns.length + 1,
      startedAt: new Date().toISOString(),
      files: new Map() // absPath -> { absPath, relPath, existed, content }
    };
  };

  const commitTurn = () => {
    if (currentTurn && currentTurn.files.size > 0) {
      turns.push(currentTurn);
      if (turns.length > maxTurns) turns.shift();
    }
    currentTurn = null;
  };

  const captureBeforeModify = async targetPath => {
    if (!targetPath) return;
    if (!currentTurn) beginTurn();
    const absPath = resolve(root, targetPath);
    if (currentTurn.files.has(absPath)) return; // Preserve the original pre-turn state.

    const relPath = relative(root, absPath).replaceAll('\\', '/') || absPath;
    try {
      const content = await readFile(absPath);
      currentTurn.files.set(absPath, { absPath, relPath, existed: true, content });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        currentTurn.files.set(absPath, { absPath, relPath, existed: false, content: null });
      }
    }
  };

  const peekLastTurn = () => {
    const active = currentTurn && currentTurn.files.size > 0 ? currentTurn : turns.at(-1);
    if (!active) return null;
    return {
      turnNumber: active.turnNumber,
      startedAt: active.startedAt,
      files: [...active.files.values()].map(f => ({
        relPath: f.relPath,
        action: f.existed ? 'restore' : 'delete'
      }))
    };
  };

  const undoLastTurn = async () => {
    const target = currentTurn && currentTurn.files.size > 0
      ? (commitTurn(), turns.pop())
      : turns.pop();
    if (!target || target.files.size === 0) {
      return { undone: false, files: [] };
    }

    const restored = [];
    for (const file of target.files.values()) {
      if (file.existed) {
        await mkdir(dirname(file.absPath), { recursive: true });
        await writeFile(file.absPath, file.content);
        restored.push({ relPath: file.relPath, action: 'restored' });
      } else {
        await unlink(file.absPath).catch(() => {});
        restored.push({ relPath: file.relPath, action: 'deleted' });
      }
    }
    return { undone: true, turnNumber: target.turnNumber, files: restored };
  };

  return {
    beginTurn,
    commitTurn,
    captureBeforeModify,
    peekLastTurn,
    undoLastTurn,
    turnCount: () => turns.length
  };
}
