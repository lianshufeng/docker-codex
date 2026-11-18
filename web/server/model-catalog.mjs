import { HttpError, requireValue } from './storage.mjs';

const defaultProvider = 'openai';
const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
const effortOptions = values => [...new Set(Array.isArray(values) ? values.filter(validId) : [])];

export function modelCatalog(bus, providers = {}) {
  const supported = () => bus.supports('model/list') && bus.supports('config/read') && bus.supports('turn/start');
  const readConfig = async cwd => (await bus.rpc('config/read', cwd ? { cwd } : {}, 5000)).config ?? {};
  let scopedCatalog;

  function supportsProviderSelection() {
    // Older app-servers silently ignore the modelProvider field and tie turns to the startup provider.
    const runId = bus.state.runId;
    if (!scopedCatalog || scopedCatalog.runId !== runId) {
      const probe = bus.rpc('model/list', { modelProvider: '__web_unconfigured_provider__', limit: 1 }, 5000)
        .then(() => false, error => {
          if (error.rpcErrorType === 'modelProviderNotConfigured' || /__web_unconfigured_provider__/.test(error.message)) return true;
          if (scopedCatalog?.probe === probe) scopedCatalog = undefined;
          throw error;
        });
      scopedCatalog = { runId, probe };
    }
    return scopedCatalog.probe;
  }

  async function list(provider, startup) {
    const models = new Map(), cursors = new Set();
    let cursor;
    do {
      if (cursors.has(cursor)) throw new HttpError(502, '执行端重复返回模型目录游标');
      cursors.add(cursor);
      const page = await bus.rpc('model/list', { limit: 100, includeHidden: false,
        ...(provider !== startup ? { modelProvider: provider } : {}), ...(cursor ? { cursor } : {}) }, 5000);
      for (const entry of page.data) {
        if (entry.hidden || !validId(entry.model)) continue;
        const efforts = effortOptions(entry.supportedReasoningEfforts?.map(option => option.reasoningEffort));
        models.set(entry.model, { id: entry.model, name: entry.displayName || entry.model, efforts,
          defaultEffort: efforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : null,
          isDefault: entry.isDefault === true });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return [...models.values()];
  }

  function definition(id) { return Object.hasOwn(providers, id) ? providers[id] : undefined; }

  async function catalog(id, effective, startup, thread) {
    const configured = definition(id);
    const name = configured?.name || (id === defaultProvider ? 'OpenAI' : id);
    if (Array.isArray(configured?.models)) {
      const models = configured.models.filter(model => validId(model?.id)).map(model => {
        const efforts = effortOptions(model.efforts);
        return { id: model.id, name: model.name || model.id, efforts, thinkingToggle: model.thinkingToggle === true,
          defaultEffort: efforts.includes(model.defaultEffort) ? model.defaultEffort : null };
      });
      return { id, name, models };
    }
    if (configured?.discover === true || id === defaultProvider) return { id, name, models: await list(id, startup) };
    const model = thread?.model || ((effective.model_provider || defaultProvider) === id && effective.model);
    return { id, name, models: model ? [{ id: model, name: model, efforts: [], defaultEffort: null }] : [] };
  }

  async function context(cwd) {
    const base = await readConfig();
    const effective = cwd ? await readConfig(cwd) : base;
    return { effective, startup: base.model_provider || defaultProvider, provider: effective.model_provider || defaultProvider };
  }

  async function options(thread, cwd = thread?.cwd) {
    if (!supported()) throw new HttpError(409, '执行端暂不支持模型选择');
    const { effective, startup, provider } = await context(cwd);
    const currentProvider = thread?.modelProvider || provider;
    const ids = thread ? [currentProvider] : [...new Set([provider, ...Object.keys(providers)])];
    const multiProvider = !ids.some(id => id !== startup) || await supportsProviderSelection().catch(() => false);
    const availableIds = multiProvider ? ids : ids.filter(id => id === startup);
    const results = await Promise.allSettled(availableIds.map(id => catalog(id, effective, startup, thread)));
    return { providers: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
      incomplete: results.some(result => result.status === 'rejected'), limited: !multiProvider,
      current: { provider: currentProvider, model: thread?.model ?? (currentProvider === provider ? effective.model : null),
        effort: thread?.reasoningEffort ?? (currentProvider === provider ? effective.model_reasoning_effort : null) } };
  }

  async function selection(value, cwd, thread) {
    requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
      validId(value.model) && (value.effort === undefined || validId(value.effort)) &&
      (thread ? value.provider === undefined : validId(value.provider) && value.effort === undefined), '模型或思考强度无效');
    if (!supported()) throw new HttpError(409, '执行端暂不支持模型选择');
    const { effective, startup, provider } = await context(cwd);
    const id = thread ? thread.modelProvider || provider : value.provider;
    requireValue(thread || id === provider || definition(id), '模型服务商不可用');
    if (id !== startup && !await supportsProviderSelection().catch(() => false)) {
      throw new HttpError(409, '当前执行端版本暂不支持切换模型服务商');
    }
    let available;
    try { available = await catalog(id, effective, startup, thread); }
    catch (error) { throw new HttpError(error.status || 502, '暂时无法验证模型目录，请刷新后重试'); }
    const model = available.models.find(candidate => candidate.id === value.model);
    requireValue(model, '模型不可用，请刷新模型列表');
    requireValue(value.effort === undefined || model.efforts.includes(value.effort), '该模型不支持此思考强度');
    return { provider: id, model: model.id, effort: value.effort ?? model.defaultEffort };
  }

  async function planDefaults(thread, resumed) {
    if (thread.model || resumed?.model) return { model: thread.model || resumed.model,
      effort: thread.reasoningEffort ?? resumed?.reasoningEffort ?? null };
    const effective = await readConfig(thread.cwd);
    const provider = effective.model_provider || defaultProvider;
    if (thread.modelProvider && thread.modelProvider !== provider) {
      throw new HttpError(409, '无法确定此会话的模型，请先选择模型');
    }
    let model = effective.model;
    if (!model) {
      const { data } = await bus.rpc('model/list');
      model = data.find(candidate => candidate.isDefault)?.model;
    }
    requireValue(validId(model), '无法确定协作模式使用的模型');
    return { model, effort: effective.model_reasoning_effort ?? null };
  }

  return { supported, options, selection, planDefaults };
}
