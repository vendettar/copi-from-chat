export const DEFAULT_MODEL_PREFERENCE = Object.freeze({ kind: 'preset', name: 'think' });

const PRESET_ALIASES = new Map([
  ['auto', 'auto'],
  ['first', 'auto'],
  ['default', 'auto'],
  ['自动', 'auto'],
  ['quick', 'quick'],
  ['fast', 'quick'],
  ['quick-response', 'quick'],
  ['quick response', 'quick'],
  ['快速响应', 'quick'],
  ['快速', 'quick'],
  ['think', 'think'],
  ['deep', 'think'],
  ['deeper', 'think'],
  ['think-deeper', 'think'],
  ['think deeper', 'think'],
  ['last', 'think'],
  ['深度思考', 'think'],
  ['深度', 'think']
]);

export function parseModelPreference(input) {
  if (input === undefined || input === null || input === '') return DEFAULT_MODEL_PREFERENCE;
  if (typeof input === 'object' && !Array.isArray(input)) {
    if (input.kind === 'preset' && ['auto', 'quick', 'think'].includes(input.name)) {
      return { kind: 'preset', name: input.name };
    }
    if (input.kind === 'index' && Number.isInteger(input.index) && input.index >= 0) {
      return { kind: 'index', index: input.index };
    }
    throw new Error('Invalid model preference object.');
  }
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0) {
      throw new Error(`Invalid model index "${input}". Use a non-negative integer (e.g. 0, 1, 2).`);
    }
    return { kind: 'index', index: input };
  }
  const raw = String(input).trim().toLowerCase();
  const preset = PRESET_ALIASES.get(raw);
  if (preset) return { kind: 'preset', name: preset };
  if (/^\d+$/.test(raw)) {
    return { kind: 'index', index: Number(raw) };
  }
  throw new Error(`Invalid model "${input}". Use auto, quick, think, or a 0-based menu index (e.g. 0, 1, 2).`);
}

export function formatModelPreference(preference) {
  const pref = parseModelPreference(preference);
  return pref.kind === 'preset' ? pref.name : String(pref.index);
}

export function modelPreferenceKey(preference) {
  const pref = parseModelPreference(preference);
  return pref.kind === 'preset' ? `preset:${pref.name}` : `index:${pref.index}`;
}

export function presetAliasForIndex(index, total) {
  if (total <= 0 || index < 0 || index >= total) return null;
  if (index === 0) return 'auto';
  if (total === 2) return index === 1 ? 'think' : null;
  if (index === total - 1) return 'think';
  if (index === 1) return 'quick';
  return null;
}

// Resolve pure positional fallback indices for a menu of `length` enabled items.
// Always falls back gracefully across valid indices so selection never fails on menu updates.
export function resolveCandidateIndices(length, preference = DEFAULT_MODEL_PREFERENCE) {
  if (!Number.isInteger(length) || length <= 0) return [];
  const pref = parseModelPreference(preference);
  let raw;
  if (pref.kind === 'index') {
    raw = pref.index < length
      ? [pref.index, length - 1, length - 2, 0]
      : [length - 1, length - 2, 0];
  } else if (pref.name === 'auto') {
    raw = [0, 1, length - 1];
  } else if (pref.name === 'quick') {
    raw = length >= 3 ? [1, length - 2, 0, length - 1] : [0, length - 1];
  } else {
    // 'think' (default): last -> second-to-last -> first
    raw = [length - 1, length - 2, 0];
  }
  return [...new Set(raw.filter(index => index >= 0 && index < length))];
}

export function getBuiltinModelPresets() {
  return [
    { value: 'auto', label: 'auto', description: 'First option (index 0 — e.g. 自动 / Auto)' },
    { value: 'quick', label: 'quick', description: 'Second option (index 1 — e.g. 快速响应 / Quick response)' },
    { value: 'think', label: 'think', description: 'Last option (default — e.g. 深度思考 / Think deeper)' }
  ];
}
