import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSearchTools } from '../src/search-tools.js';

const exec = promisify(execFile);
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const git = args => exec('git', args, { cwd });
  await git(['init', '-q']);
  // Use an isolated excludes file to exercise the global-excludes mechanism without changing user config.
  const excludes = join(root, 'excludes');
  await writeFile(excludes, '*.global\n');
  await git(['config', 'core.excludesFile', excludes]);
  await writeFile(join(cwd, '.git/info/exclude'), '*.local\n');
  const files = {
    '.gitignore': 'build/\n.idea/\n*.tmp\n',
    'src/main.js': 'const result = "NEEDLE";\r\n',
    'src/new file.js': 'NEEDLE new file\n',
    'src/中文文件.js': 'NEEDLE unicode\n',
    'nested/.gitignore': '!keep.tmp\n*.skip\n',
    'nested/keep.tmp': 'NEEDLE allowed by negation\n',
    'nested/drop.skip': 'NEEDLE ignored nested rule\n',
    'root.tmp': 'NEEDLE ignored parent rule\n',
    'root.local': 'NEEDLE excluded locally\n',
    'root.global': 'NEEDLE excluded globally\n',
    'build/generated.js': 'NEEDLE ignored build\n',
    'build/tracked.js': 'NEEDLE ignored even though tracked\n',
    '.idea/patches/local.patch': 'NEEDLE ignored patch\n',
    'empty.js': '',
    'binary.bin': Buffer.from('NEEDLE\0binary\n')
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), text);
  }
  await git(['add', 'src/main.js']);
  await git(['add', '-f', 'build/tracked.js']);
  const tools = Object.fromEntries(createSearchTools(cwd).map(tool => [tool.name, tool]));
  const call = async (name, args, signal) => (await tools[name].execute('test', args, signal)).content[0].text;
  return { cwd, call };
}

test('content search respects nested, global and local ignore rules, including ignored tracked files', async t => {
  const { call } = await project(t);
  const result = await call('grep', { pattern: 'NEEDLE' });
  for (const path of ['src/main.js', 'src/new file.js', 'src/中文文件.js', 'nested/keep.tmp']) assert.ok(result.includes(path));
  for (const ignored of ['build/', '.idea/', 'drop.skip', 'root.tmp', 'root.local', 'root.global', 'binary.bin', '.git/']) assert.ok(!result.includes(ignored), ignored);
  assert.match(result, /src\/main\.js:1:/);
  assert.equal(result.includes('\r'), false);
});

test('file discovery includes new and empty files while excluding all ignored paths', async t => {
  const { call } = await project(t);
  const result = await call('find', { pattern: '*' });
  assert.ok(result.includes('src/new file.js'));
  assert.ok(result.includes('empty.js'));
  assert.ok(result.includes('nested/keep.tmp'));
  for (const ignored of ['build/', '.idea/', 'drop.skip', 'root.tmp', 'root.local', 'root.global', '.git/']) assert.ok(!result.includes(ignored), ignored);
  assert.deepEqual((await call('find', { path: 'src', pattern: '*.js' })).split('\n').sort(), ['main.js', 'new file.js', '中文文件.js']);
});

test('search scopes, wildcard filters, literal/regex matching and option-like text work without a shell', async t => {
  const { cwd, call } = await project(t);
  await writeFile(join(cwd, 'src/quoted.txt'), 'a.b\naxb\n--flag $(touch should-not-exist)\n');
  assert.equal(await call('grep', { path: 'src/quoted.txt', pattern: 'a.b' }), 'quoted.txt:1:a.b');
  assert.equal((await call('grep', { path: 'src/quoted.txt', pattern: 'a.b', literal: false })).split('\n').length, 2);
  assert.ok((await call('grep', { path: 'src', glob: '*.js', pattern: 'needle', ignoreCase: true })).includes('main.js:1:'));
  assert.ok(!(await call('grep', { path: 'src', glob: '*.txt', pattern: 'NEEDLE' })).includes('.js:'));
  assert.ok((await call('grep', { pattern: '--flag $(touch should-not-exist)' })).includes('quoted.txt:3:'));
  assert.equal(await call('find', { pattern: 'should-not-exist' }), 'No matches.');
  assert.equal(await call('grep', { pattern: 'absent_keyword' }), 'No matches.');
  await assert.rejects(call('grep', { pattern: '[', literal: false }), /search failed/i);
});

test('large search output is bounded for web messages and never presented as a complete search', async t => {
  const { cwd, call } = await project(t);
  await writeFile(join(cwd, 'many.txt'), Array.from({ length: 4000 }, (_, i) => `hit ${i} ${'\\"'.repeat(500)}`).join('\n'));
  const result = await call('grep', { pattern: 'hit', limit: 200 });
  assert.ok(JSON.stringify(result).length < 8400);
  assert.match(result, /Partial results/);
  assert.match(result, /line truncated/);
  const limited = await call('find', { pattern: '*', limit: 2 });
  assert.equal(limited.split('\n\n')[0].split('\n').length, 2);
  assert.match(limited, /Partial results/);
});

test('cancellation and a non-repository path never trigger an unrestricted search', async t => {
  const { cwd, call } = await project(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(call('grep', { pattern: 'NEEDLE' }, controller.signal), { name: 'AbortError' });
  await assert.rejects(call('find', { pattern: '*', path: dirname(cwd) }), error => {
    assert.match(error.message, /version-controlled project/);
    assert.doesNotMatch(error.message, /\bgit\b/i);
    assert.ok(error.cause); // Local diagnostics retain the process error without putting it in model context.
    return true;
  });
});

test('grep supports optional context lines in both Git repos and non-Git fallback workspaces', async t => {
  const { cwd, call } = await project(t);
  await writeFile(join(cwd, 'src/ctx.js'), [
    'const before2 = 1;',
    'const before1 = 2;',
    'const TARGET_LINE = 3;',
    'const after1 = 4;',
    'const after2 = 5;'
  ].join('\n') + '\n');

  const gitRes = await call('grep', { path: 'src/ctx.js', pattern: 'TARGET_LINE', context: 2 });
  assert.match(gitRes, /ctx\.js-1-const before2 = 1;/);
  assert.match(gitRes, /ctx\.js-2-const before1 = 2;/);
  assert.match(gitRes, /ctx\.js:3:const TARGET_LINE = 3;/);
  assert.match(gitRes, /ctx\.js-4-const after1 = 4;/);
  assert.match(gitRes, /ctx\.js-5-const after2 = 5;/);

  // Non-Git directory with allowNonGitFallback: true
  const nonGitDir = await mkdtemp(join(tmpdir(), 'copi-grep-ctx-nongit-'));
  t.after(() => rm(nonGitDir, { recursive: true, force: true }));
  await writeFile(join(nonGitDir, 'sample.js'), [
    'line1',
    'line2',
    'HIT_ONE',
    'line4',
    'line5',
    'line6',
    'line7',
    'HIT_TWO',
    'line9'
  ].join('\n') + '\n');

  const tools = Object.fromEntries(createSearchTools(nonGitDir, { allowNonGitFallback: true }).map(tool => [tool.name, tool]));
  const nonGitRes = (await tools.grep.execute('c1', { pattern: 'HIT_', context: 1 })).content[0].text;
  assert.match(nonGitRes, /sample\.js-2-line2/);
  assert.match(nonGitRes, /sample\.js:3:HIT_ONE/);
  assert.match(nonGitRes, /sample\.js-4-line4/);
  assert.match(nonGitRes, /\n--\n/);
  assert.match(nonGitRes, /sample\.js-7-line7/);
  assert.match(nonGitRes, /sample\.js:8:HIT_TWO/);
  assert.match(nonGitRes, /sample\.js-9-line9/);
});
