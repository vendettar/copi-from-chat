import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL_PREFERENCE, formatModelPreference, getBuiltinModelPresets,
  parseModelPreference, presetAliasForIndex, resolveCandidateIndices
} from '../src/model-preference.js';
import { ensureCopiDirs, getCopiPaths } from '../src/paths.js';
import { readConfig, saveConfig } from '../src/storage.js';

test('parseModelPreference accepts presets, Chinese aliases, and 0-based numeric indices', () => {
  assert.deepEqual(parseModelPreference(), DEFAULT_MODEL_PREFERENCE);
  assert.deepEqual(parseModelPreference('auto'), { kind: 'preset', name: 'auto' });
  assert.deepEqual(parseModelPreference('自动'), { kind: 'preset', name: 'auto' });
  assert.deepEqual(parseModelPreference('quick'), { kind: 'preset', name: 'quick' });
  assert.deepEqual(parseModelPreference('快速响应'), { kind: 'preset', name: 'quick' });
  assert.deepEqual(parseModelPreference('think'), { kind: 'preset', name: 'think' });
  assert.deepEqual(parseModelPreference('深度思考'), { kind: 'preset', name: 'think' });
  assert.deepEqual(parseModelPreference('0'), { kind: 'index', index: 0 });
  assert.deepEqual(parseModelPreference(2), { kind: 'index', index: 2 });
  assert.throws(() => parseModelPreference('unknown-model'), /Invalid model/);
  assert.throws(() => parseModelPreference(-1), /Invalid model index/);
  assert.equal(formatModelPreference({ kind: 'preset', name: 'quick' }), 'quick');
  assert.equal(formatModelPreference({ kind: 'index', index: 3 }), '3');
  assert.equal(getBuiltinModelPresets().length, 3);
});

test('resolveCandidateIndices produces safe positional fallback orders for every preference', () => {
  // 3-item menu: [0: Auto, 1: Quick, 2: Think]
  assert.deepEqual(resolveCandidateIndices(3, 'think'), [2, 1, 0]);
  assert.deepEqual(resolveCandidateIndices(3, 'quick'), [1, 0, 2]);
  assert.deepEqual(resolveCandidateIndices(3, 'auto'), [0, 1, 2]);
  assert.deepEqual(resolveCandidateIndices(3, 1), [1, 2, 0]);
  // Out-of-range index falls back gracefully without erroring
  assert.deepEqual(resolveCandidateIndices(3, 9), [2, 1, 0]);
  // 2-item and 1-item menus stay within bounds
  assert.deepEqual(resolveCandidateIndices(2, 'quick'), [0, 1]);
  assert.deepEqual(resolveCandidateIndices(2, 'think'), [1, 0]);
  assert.deepEqual(resolveCandidateIndices(1, 'think'), [0]);
  assert.deepEqual(resolveCandidateIndices(0, 'think'), []);

  assert.equal(presetAliasForIndex(0, 3), 'auto');
  assert.equal(presetAliasForIndex(1, 3), 'quick');
  assert.equal(presetAliasForIndex(2, 3), 'think');
  assert.equal(presetAliasForIndex(1, 2), 'think');
});

test('config storage persists and reloads modelPreference under ~/.copi/config.json', async t => {
  const root = await mkdtemp(join(tmpdir(), 'copi-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureCopiDirs(getCopiPaths(root));
  assert.deepEqual(await readConfig(paths), {});
  await saveConfig(paths, { modelPreference: 'quick' });
  assert.deepEqual(await readConfig(paths), { modelPreference: 'quick' });
  await saveConfig(paths, { modelPreference: '2' });
  assert.deepEqual(await readConfig(paths), { modelPreference: '2' });
});
