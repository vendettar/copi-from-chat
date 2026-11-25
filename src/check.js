import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function listJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listJs(full)));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files.sort();
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.private === true) throw new Error('package.json must not set private: true for portable tgz packaging.');
  if (pkg.name !== 'copi-from-chat') throw new Error(`Expected package name "copi-from-chat", got "${pkg.name}".`);
  if (!pkg.bin?.copi) throw new Error('package.json is missing bin.copi.');
  await access(join(ROOT, pkg.bin.copi));

  const agentSource = await readFile(join(ROOT, pkg.bin.copi), 'utf8');
  if (!agentSource.startsWith('#!/usr/bin/env node')) {
    throw new Error(`${pkg.bin.copi} must start with #!/usr/bin/env node.`);
  }

  const depNames = Object.keys(pkg.dependencies ?? {}).sort();
  const bundled = [...(pkg.bundleDependencies ?? pkg.bundledDependencies ?? [])].sort();
  if (JSON.stringify(depNames) !== JSON.stringify(bundled)) {
    throw new Error('bundleDependencies must match dependencies so npm pack produces a portable tgz.');
  }

  for (const doc of ['README.md', 'ROADMAP.md', 'UPGRADE-SUMMARY.md']) {
    await access(join(ROOT, doc));
  }

  const files = [
    ...(await listJs(join(ROOT, 'src'))),
    ...(await listJs(join(ROOT, 'test')))
  ];
  for (const file of files) {
    await exec(process.execPath, ['--check', file]);
  }

  console.log(`Check passed (${files.length} JS files, package ${pkg.name}@${pkg.version}).`);
}

main().catch(error => {
  console.error(`Check failed: ${error.message}`);
  process.exitCode = 1;
});
