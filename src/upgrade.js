import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stopBrowserHost } from './browser-client.js';

export const DEFAULT_UPGRADE_REPO = 'vendettar/copi-from-chat';
const PACKAGE_JSON = new URL('../package.json', import.meta.url);

export function parseSemver(version) {
  const clean = String(version ?? '').trim().replace(/^v/i, '').split('-')[0];
  const parts = clean.split('.').map(n => Number(n));
  if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0)) return null;
  return parts;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestRelease({
  repo = DEFAULT_UPGRADE_REPO,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'copi-from-chat-cli'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`GitHub Releases API returned HTTP ${res.status} (${res.statusText}).`);
    }
    const data = await res.json();
    const tag = String(data.tag_name ?? '').trim();
    const version = tag.replace(/^v/i, '');
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const tgz = assets.find(a => typeof a?.name === 'string' && a.name.endsWith('.tgz') && typeof a.browser_download_url === 'string');
    return {
      tag,
      version,
      title: String(data.name ?? tag),
      htmlUrl: String(data.html_url ?? ''),
      assetName: tgz?.name ?? null,
      downloadUrl: tgz?.browser_download_url ?? null,
      notes: String(data.body ?? '').trim()
    };
  } finally {
    clearTimeout(timer);
  }
}

function defaultInstallTgz(downloadUrl) {
  return new Promise((resolveInstall, rejectInstall) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npm.cmd' : 'npm';
    const child = spawn(cmd, ['install', '-g', downloadUrl], {
      stdio: 'inherit',
      shell: isWin,
      windowsHide: false
    });
    child.on('error', rejectInstall);
    child.on('close', code => {
      if (code === 0) resolveInstall();
      else rejectInstall(new Error(`npm install -g exited with code ${code}`));
    });
  });
}

export async function runUpgrade({
  paths,
  currentVersion,
  checkOnly = false,
  repo = DEFAULT_UPGRADE_REPO,
  fetchImpl = globalThis.fetch,
  stopHost = stopBrowserHost,
  installPackage = defaultInstallTgz,
  log = console.log
} = {}) {
  const current = currentVersion ?? JSON.parse(await readFile(PACKAGE_JSON, 'utf8')).version;
  const latest = await fetchLatestRelease({ repo, fetchImpl });
  if (!latest.version) {
    throw new Error('Could not determine the latest version from GitHub Releases.');
  }

  const cmp = compareSemver(latest.version, current);
  if (cmp <= 0) {
    log(`copi is already up to date (v${current}).`);
    return { updated: false, alreadyLatest: true, current, latest: latest.version };
  }

  log(`Update available: v${current} -> v${latest.version} (${latest.title})`);
  if (checkOnly) {
    if (latest.htmlUrl) log(`Release: ${latest.htmlUrl}`);
    log('Run "copi upgrade" to install automatically.');
    return { updated: false, updateAvailable: true, current, latest: latest.version, downloadUrl: latest.downloadUrl };
  }

  if (!latest.downloadUrl) {
    throw new Error(`Release ${latest.tag} has no .tgz asset attached. Check ${latest.htmlUrl || repo}.`);
  }

  if (paths) {
    const stopped = await stopHost(paths).catch(() => ({ stopped: false }));
    if (stopped?.stopped) {
      log(`Stopped running Browser Host (PID ${stopped.pid}) before upgrade.`);
    }
  }

  log(`Installing ${latest.assetName ?? latest.downloadUrl}...`);
  await installPackage(latest.downloadUrl);
  log(`Upgraded copi to v${latest.version}.`);
  return { updated: true, from: current, to: latest.version, downloadUrl: latest.downloadUrl };
}
