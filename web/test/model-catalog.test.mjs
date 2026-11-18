import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCatalog } from '../server/model-catalog.mjs';

test('official directory follows the current catalog and validates only advertised efforts', async () => {
  let remote = 'gpt-new';
  const bus = { supports: () => true, state: { runId: 'one' }, async rpc(method, params) {
    if (method === 'config/read') return { config: { model_provider: 'openai', secret: 'server-only' } };
    if (params.cursor) return { data: [{ model: remote, displayName: '新模型', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] };
    return { data: [{ model: 'hidden', hidden: true }], nextCursor: 'next' };
  } };
  const catalog = modelCatalog(bus);
  const thread = { cwd: '/workspace', modelProvider: 'openai' };
  const first = await catalog.options(thread);
  assert.deepEqual(first.providers[0].models.map(model => model.id), ['gpt-new']);
  assert.doesNotMatch(JSON.stringify(first), /server-only/);
  assert.deepEqual(await catalog.selection({ model: 'gpt-new' }, thread.cwd, thread),
    { provider: 'openai', model: 'gpt-new', effort: 'low' });
  await assert.rejects(catalog.selection({ model: 'gpt-new', effort: 'high' }, thread.cwd, thread), { status: 400 });
  remote = 'gpt-replacement';
  assert.deepEqual((await catalog.options(thread)).providers[0].models.map(model => model.id), [remote]);
  await assert.rejects(catalog.selection({ model: 'gpt-new' }, thread.cwd, thread), { status: 400 });
});

test('legacy lists cannot be mistaken for another provider’s directory', async () => {
  let supportsScopedList = false;
  const bus = { supports: () => true, state: { runId: 'old' }, async rpc(method, params) {
    if (method === 'config/read') return { config: { model_provider: 'local', model: 'llama' } };
    if (supportsScopedList && params.modelProvider === '__web_unconfigured_provider__') {
      throw new Error('model provider __web_unconfigured_provider__ is not configured');
    }
    return { data: [{ model: supportsScopedList ? 'gpt' : 'llama' }] };
  } };
  const catalog = modelCatalog(bus, { openai: {}, local: { models: [{ id: 'llama' }] } });
  const old = await catalog.options();
  assert.equal(old.limited, true);
  assert.deepEqual(old.providers.map(provider => provider.id), ['local']);
  await assert.rejects(catalog.selection({ provider: 'openai', model: 'gpt' }, '/workspace'), { status: 409 });
  assert.equal((await catalog.selection({ provider: 'local', model: 'llama' }, '/workspace')).effort, null);
  await assert.rejects(catalog.selection({ provider: 'unknown', model: 'llama' }, '/workspace'), { status: 400 });
  supportsScopedList = true;
  bus.state.runId = 'new';
  const latest = await catalog.options();
  assert.equal(latest.limited, false);
  assert.equal(latest.providers.find(provider => provider.id === 'openai').models[0].id, 'gpt');
});
