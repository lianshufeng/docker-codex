import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import './model-picker.css';

export type ModelSettings = { model: string; effort?: string };
type Model = { id: string; name: string; efforts: string[]; defaultEffort: string | null; thinkingToggle?: boolean; isDefault?: boolean };
type Provider = { id: string; name: string; models: Model[] };
type Catalog = { providers: Provider[]; incomplete: boolean; limited: boolean;
  current: { provider: string; model: string | null; effort: string | null } };
export type NewSessionModel = { provider: string; model: string };

export function useModelCatalog(request: (path: string, init: RequestInit) => Promise<Catalog>, url: string,
  enabled: boolean, generation: string | undefined, refreshAfter = false) {
  const key = JSON.stringify([url, generation]);
  const [state, setState] = useState<{ key: string; catalog?: Catalog; failed?: boolean }>();
  const [revision, refresh] = useState(0);
  useEffect(() => {
    if (!enabled || refreshAfter) return;
    const controller = new AbortController();
    request(url, { signal: controller.signal }).then(catalog => {
      if (!controller.signal.aborted) setState({ key, catalog });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ key, failed: true });
    });
    return () => controller.abort();
  }, [request, url, enabled, key, revision, refreshAfter]);
  return { catalog: enabled && state?.key === key ? state.catalog : undefined,
    failed: enabled && state?.key === key && state.failed,
    refresh: (clear = true) => { if (clear) setState(undefined); refresh(value => value + 1); } };
}

function effortLabel(effort: string, model: Model) {
  if (model.thinkingToggle) return effort === 'none' ? '关闭' : '开启';
  const labels: Record<string, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高',
    xhigh: '很高', max: '最高', ultra: '超高' };
  return labels[effort] ?? effort;
}

type CatalogProps = ReturnType<typeof useModelCatalog> & { disabled: boolean };

export function SessionModelPicker({ catalog, failed, refresh, disabled, value, onChange }: CatalogProps & {
  value?: ModelSettings; onChange: (value?: ModelSettings) => void;
}) {
  const models = catalog?.providers[0]?.models ?? [];
  const current = catalog?.current.model || models.find(model => model.isDefault)?.id;
  const model = models.find(option => option.id === (value?.model || current));
  const currentEffort = catalog?.current.effort;
  const effort = value ? value.effort ?? model?.defaultEffort : currentEffort ?? model?.defaultEffort;
  const stale = Boolean(value && (!model || value.effort && !model.efforts.includes(value.effort)));
  return <span className="model-settings">
    <select aria-label="模型" title={model?.name || current || '模型'} disabled={disabled || !models.length}
      value={value?.model && model ? value.model : ''} onChange={event => {
        if (!event.target.value) return onChange(undefined);
        const next = models.find(option => option.id === event.target.value);
        onChange({ model: event.target.value, effort: effort && next?.efforts.includes(effort) ? effort : undefined });
      }}>
      <option value="">{current ? `当前 · ${models.find(option => option.id === current)?.name || current}` : '执行端默认模型'}</option>
      {models.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>
    <select aria-label="思考强度" title="思考强度" disabled={disabled || !model?.efforts.length}
      value={effort && model?.efforts.includes(effort) ? effort : ''} onChange={event => model && onChange({
        model: model.id, effort: event.target.value || undefined,
      })}>
      {(!effort || !model?.efforts.includes(effort)) && <option value="" disabled>使用服务默认值</option>}
      {model?.efforts.map(option => <option key={option} value={option}>{effortLabel(option, model)}</option>)}
    </select>
    <button type="button" className="icon-button model-refresh" aria-label="刷新模型列表" title="刷新模型列表"
      disabled={disabled} onClick={() => { onChange(undefined); refresh(); }}><RefreshCw size={13}/></button>
    {(failed || catalog?.incomplete || stale) && <small role="status">模型目录不可用或已变更，请刷新</small>}
    {catalog?.limited && <small role="status">当前执行端暂不支持此会话的模型切换</small>}
  </span>;
}

export function NewSessionModelPicker({ catalog, failed, refresh, disabled, value, onChange }: CatalogProps & {
  value?: NewSessionModel; onChange: (value?: NewSessionModel) => void;
}) {
  const choices = catalog?.providers.filter(provider => provider.models.length) ?? [];
  const encoded = value ? JSON.stringify([value.provider, value.model]) : '';
  const listed = choices.some(provider => provider.id === value?.provider && provider.models.some(model => model.id === value.model));
  return <div className="new-session-model">
    <label>模型
      <select disabled={disabled || !choices.length} value={listed ? encoded : ''} onChange={event => {
        if (!event.target.value) return onChange(undefined);
        const [provider, model] = JSON.parse(event.target.value);
        onChange({ provider, model });
      }}>
        <option value="">执行端默认模型</option>
        {choices.map(provider => <optgroup key={provider.id} label={provider.name}>
          {provider.models.map(model => <option key={model.id} value={JSON.stringify([provider.id, model.id])}>{model.name}</option>)}
        </optgroup>)}
      </select>
    </label>
    {(failed || catalog?.incomplete) && <button type="button" disabled={disabled} onClick={() => { onChange(undefined); refresh(); }}>重新加载模型目录</button>}
    {catalog?.limited && <small role="status">当前执行端仅支持启动时配置的模型服务商</small>}
  </div>;
}
