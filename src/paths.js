import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid profile name "${name}". Use 1-64 letters, digits, ".", "_", or "-".`);
  }
  return name;
}

export function normalizeCliPath(inputPath, platform = process.platform) {
  if (typeof inputPath !== 'string') return inputPath;
  const trimmed = inputPath.trim();
  if (!trimmed) return trimmed;
  if (platform === 'win32') {
    // Convert Git Bash / MSYS POSIX drive paths such as /c/path/to/project into C:/path/to/project.
    const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed);
    if (msys) {
      const drive = msys[1].toUpperCase();
      const rest = msys[2] ?? '';
      return `${drive}:/${rest}`;
    }
  }
  return trimmed;
}

export function getCopiHome(env = process.env) {
  const override = env.COPI_HOME?.trim();
  return resolve(override || join(homedir(), '.copi'));
}

export function getCopiPaths(home = getCopiHome()) {
  const root = resolve(home);
  const browserProfilesDir = join(root, 'browser-profiles');
  return {
    home: root,
    sessionsDir: join(root, 'sessions'),
    sharedProfileDir: join(root, 'shared-browser-profile'),
    browserProfilesDir,
    profileDir(name) {
      return join(browserProfilesDir, validateProfileName(name));
    },
    activityLog: join(root, 'activity.jsonl'),
    checkpointsDir: join(root, 'checkpoints'),
    locksDir: join(root, 'locks'),
    browserHostFile: join(root, 'browser-host.json'),
    inputDiagnosticFile: join(root, 'input-diagnostic.json')
  };
}

export async function ensureCopiDirs(paths = getCopiPaths()) {
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.sessionsDir, { recursive: true }),
    mkdir(paths.sharedProfileDir, { recursive: true }),
    mkdir(paths.browserProfilesDir, { recursive: true }),
    mkdir(paths.checkpointsDir, { recursive: true }),
    mkdir(paths.locksDir, { recursive: true })
  ]);
  return paths;
}
