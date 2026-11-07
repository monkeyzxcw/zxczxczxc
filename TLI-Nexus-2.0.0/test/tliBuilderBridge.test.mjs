import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWithTliBuilder, getTliBuilderStatus } from '../core/tliBuilderBridge.js';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.TLI_BUILDER_URL;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.TLI_BUILDER_URL;
  else process.env.TLI_BUILDER_URL = originalUrl;
});

test('status reports the local TLIBuilder conditions endpoint', async () => {
  process.env.TLI_BUILDER_URL = 'http://127.0.0.1:8765';
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'http://127.0.0.1:8765/api/conditions');
    return new Response(JSON.stringify({ Combat: [{ key: 'enemy_boss' }], Skill: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const status = await getTliBuilderStatus();
  assert.equal(status.connected, true);
  assert.equal(status.conditionCategories, 2);
});

test('calculation posts only supported request keys to the engine endpoint', async () => {
  process.env.TLI_BUILDER_URL = 'http://127.0.0.1:8765';
  let sent;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:8765/api/engine/stats');
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ offense: {}, defense: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const result = await calculateWithTliBuilder({
    slots: [{ treeName: 'test_tree', nodeStates: {} }],
    skills: [],
    gear: [],
    injectedField: 'must-not-cross-the-bridge',
  });
  assert.deepEqual(result, { offense: {}, defense: {} });
  assert.equal(sent.injectedField, undefined);
  assert.equal(sent.slots.length, 1);
});

test('calculation rejects malformed builds before making a request', async () => {
  await assert.rejects(() => calculateWithTliBuilder({ skills: [] }), /slots/);
  await assert.rejects(() => calculateWithTliBuilder(null), /объект билда/i);
});

test('status refuses a non-loopback backend URL', async () => {
  process.env.TLI_BUILDER_URL = 'http://example.com:8765';
  globalThis.fetch = async () => { throw new Error('must not fetch a remote host'); };
  const status = await getTliBuilderStatus();
  assert.equal(status.connected, false);
  assert.match(status.message, /loopback/i);
});
