import { isAbsolute, relative, resolve } from 'node:path';
import { normalizeCliPath } from './paths.js';

const DESTRUCTIVE_BASH_RULES = [
  {
    pattern: /(?:^|[;&|]\s*)rm\s+(?:[^\n;&|]*\s)?-(?:[a-zA-Z]*[rf][a-zA-Z]*)\b/,
    reason: 'Recursive or forced file deletion (rm -r / rm -f)'
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: 'Destructive git reset --hard (discards uncommitted changes)'
  },
  {
    pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?|\s-f\b)/i,
    reason: 'Force push to a git remote'
  },
  {
    pattern: /\bgit\s+clean\b[^\n;&|]*-[a-zA-Z]*f/i,
    reason: 'Destructive git clean (permanently deletes untracked files)'
  },
  {
    pattern: /\bgit\s+branch\s+-D\b/,
    reason: 'Force-deleting a git branch (-D)'
  },
  {
    pattern: /\b(?:rmdir\s+\/s|del\s+\/[fsq]|Remove-Item\b[^\n;&|]*-Recurse|Format-Volume|diskpart|reg\s+delete|shutdown\b|taskkill\s+\/f|mkfs\b|dd\s+if=)/i,
    reason: 'Destructive system or filesystem command'
  },
  {
    pattern: /\b(?:curl|wget|iwr|irm)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|node|python)\b/i,
    reason: 'Piping remote content directly into an interpreter'
  }
];

function isInsideDirectory(dir, target) {
  const rel = relative(dir, target);
  if (!rel) return true;
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}

export function isPathOutsideWorkspace(cwd, targetPath, allowedDirs = []) {
  if (!cwd || typeof targetPath !== 'string' || !targetPath.trim()) return false;
  const root = resolve(cwd);
  const target = resolve(root, normalizeCliPath(targetPath));
  if (isInsideDirectory(root, target)) return false;
  if (Array.isArray(allowedDirs)) {
    for (const extra of allowedDirs) {
      if (typeof extra !== 'string' || !extra.trim()) continue;
      if (isInsideDirectory(resolve(root, normalizeCliPath(extra)), target)) return false;
    }
  }
  return true;
}

export function assessToolRisk({ toolName, input = {}, cwd, allowedDirs = [] }) {
  if (toolName === 'bash' && typeof input?.command === 'string') {
    const command = input.command.trim();
    for (const rule of DESTRUCTIVE_BASH_RULES) {
      if (rule.pattern.test(command)) {
        const preview = command.length > 240 ? `${command.slice(0, 240)}...` : command;
        return {
          risky: true,
          title: 'Confirm risky bash command',
          reason: rule.reason,
          detail: `${rule.reason}\n\nCommand:\n${preview}\n\nAllow this command to run?`
        };
      }
    }
  }

  if ((toolName === 'write' || toolName === 'edit') && typeof input?.path === 'string') {
    if (isPathOutsideWorkspace(cwd, input.path, allowedDirs)) {
      const resolved = resolve(cwd, normalizeCliPath(input.path));
      return {
        risky: true,
        title: `Confirm ${toolName} outside workspace`,
        reason: `Target path is outside the project directory (${resolved})`,
        detail: `Tool "${toolName}" wants to modify a file outside the current workspace:\n\nWorkspace: ${resolve(cwd)}\nTarget:    ${resolved}\n\nAllow this file modification? (Tip: use /allow-dir <dir> to authorize an extra folder for this session)`
      };
    }
  }

  return { risky: false };
}
