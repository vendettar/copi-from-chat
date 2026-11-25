import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Loader, Text, TuiMainScreen } from '@earendil-works/pi-tui';
import { createBashToolDefinition, initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { createWebUI } from '../src/web-ui.js';

initTheme('dark');

async function fixture(t) {
  const handlers = new Map(), resolvers = [], writes = [], messages = [];
  const webUI = createWebUI({ async close() {} });
  webUI.extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    registerToolRenderer: resolver => resolvers.push(resolver)
  });
  // Exercise Pi's actual renderer and timers without a real terminal or a browser request.
  const terminal = { columns: 80, rows: 24, write: text => writes.push(text), hideCursor() {}, showCursor() {}, stop() {} };
  const tui = new TuiMainScreen(terminal);
  let indicator, loader;
  const ctx = { mode: 'tui', cwd: process.cwd(), ui: {
    setTitle() {}, setHeader() {}, setFooter() {},
    setWorkingIndicator(value) { indicator = value; loader?.setIndicator(value); },
    setWorkingMessage(message) { messages.push(message); loader?.setMessage(message ?? ''); }
  } };
  await handlers.get('session_start')({}, ctx);
  loader = new Loader(tui, text => text, text => text, 'Waiting for Copilot...', indicator);
  tui.addChild(new Text(Array.from({ length: 80 }, (_, i) => `History ${i}`).join('\n'), 0, 0));
  tui.addChild(loader);
  t.after(async () => {
    loader.stop();
    tui.stop({ preserveScreen: true });
    await handlers.get('session_shutdown')();
  });
  const resolve = (name, base) => resolvers.reduceRight((next, resolver) => () => resolver(name, next), () => base)();
  return { webUI, handlers, tui, loader, writes, messages, resolve };
}

test('waiting for a buffered web reply does not keep writing to terminal scrollback', async t => {
  const { webUI, tui, writes } = await fixture(t);
  webUI.onStatus('Waiting for Copilot...');
  tui.renderNow();
  await delay(60);
  writes.length = 0;
  await delay(250);
  assert.deepEqual(writes, []);
  webUI.onStatus('Receiving Copilot reply...');
  await delay(60);
  assert.ok(writes.some(text => text.includes('Receiving Copilot reply...')));
});

test('an off-screen running Bash row does not replay history just to update elapsed time', async t => {
  const { tui, loader, writes, resolve } = await fixture(t);
  const definition = createBashToolDefinition(process.cwd());
  const renderers = resolve('bash', definition);
  const row = new ToolExecutionComponent('bash', 'build', { command: 'npm run build' }, {},
    { ...definition, ...renderers }, tui, process.cwd());
  const result = { content: [{ type: 'text', text: 'Building...' }], isError: false };
  t.after(() => row.updateResult({ ...result, durationMs: 4200 }, false));
  tui.removeChild(loader);
  tui.addChild(row);
  // Later tool calls can push the still-running command above the terminal's viewport.
  tui.addChild(new Text(Array.from({ length: 30 }, (_, i) => `Other tool output ${i}`).join('\n'), 0, 0));
  tui.addChild(loader);
  row.markExecutionStarted();
  row.updateResult(result, true);
  tui.renderNow();
  await delay(60);
  const redraws = tui.fullRedraws;
  writes.length = 0;
  await delay(1250);
  assert.equal(tui.fullRedraws, redraws);
  assert.equal(writes.some(text => text.includes('History 0')), false);

  // Real progress still renders; the compact final result keeps its recorded duration and expands on Ctrl+O.
  row.updateResult({ ...result, content: [{ type: 'text', text: 'Build progress changed.' }] }, true);
  tui.requestRender();
  await delay(60);
  assert.ok(writes.some(text => text.includes('Build progress changed.')));
  row.updateResult({ ...result, durationMs: 4200 }, false);
  const collapsed = row.render(100).join('\n');
  assert.match(collapsed, /Took 4\.2s/);
  assert.match(collapsed, /Ctrl\+O/);
  assert.equal(renderers.execute, definition.execute);
  assert.equal(renderers.parameters, definition.parameters);

  // read tool also uses compact 1-line rendering when collapsed and full renderer when expanded.
  const readRenderers = resolve('read', definition);
  assert.notEqual(readRenderers, definition);
  assert.equal(resolve('unknown_custom_tool', definition), definition);
});

test('working status changes once per phase and resets between agent turns', async t => {
  const { webUI, handlers, messages } = await fixture(t);
  handlers.get('agent_start')();
  webUI.onStatus('Waiting for Copilot...');
  webUI.onStatus('Receiving Copilot reply...');
  webUI.onStatus('Receiving Copilot reply...');
  handlers.get('tool_execution_start')();
  handlers.get('tool_execution_start')();
  handlers.get('agent_end')();
  handlers.get('agent_start')();
  assert.deepEqual(messages, [
    'Waiting for Copilot...', 'Receiving Copilot reply...', 'Running tools...', undefined, 'Waiting for Copilot...'
  ]);
});
