import React, { useState } from 'react';
import { externalUrl, formFields, validField, type FormField } from '../../elicitation.mjs';

function Field({ field, index }: { field: FormField; index: number }) {
  const name = String(index);
  const options = field.options ?? (field.type === 'boolean'
    ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }] : null);
  const initial = field.default === undefined ? -1 : options?.findIndex(option => option.value === String(field.default)) ?? -1;
  const label = field.title || field.name;
  if (field.type === 'array') {
    const defaults = Array.isArray(field.default) ? field.default : [];
    return <fieldset>
      <legend>{label}{field.required && '（必填）'}</legend>
      {field.description && <p>{field.description}</p>}
      {options?.map((option, i) => <label className="elicitation-choice" key={i}>
        <input type="checkbox" name={name} value={i} defaultChecked={defaults.includes(option.value)}/>
        {option.label}
      </label>)}
    </fieldset>;
  }
  const numeric = field.type === 'number' || field.type === 'integer';
  const inputType = numeric ? 'number' : field.format === 'email' ? 'email' : field.format === 'date' ? 'date' : 'text';
  return <fieldset>
    <label>
      <span>{label}{field.required && '（必填）'}</span>
      {field.description && <span>{field.description}</span>}
      {options ? <select name={name} required={field.required} defaultValue={initial < 0 ? '' : String(initial)}>
        <option value="">{field.required ? '请选择' : '不填写'}</option>
        {options.map((option, i) => <option value={i} key={i}>{option.label}</option>)}
      </select> : <input name={name} type={inputType} defaultValue={typeof field.default === 'string' ||
        typeof field.default === 'number' ? field.default : undefined} min={field.minimum} max={field.maximum}
        step={field.type === 'integer' ? 1 : numeric ? 'any' : undefined}
        placeholder={field.format === 'date-time' ? '2026-01-01T12:00:00+09:00' : undefined}/>}
    </label>
  </fieldset>;
}

type Action = 'accept' | 'decline' | 'cancel';

export function ElicitationForm({ request, respond }: {
  request: { mode: string; message: string; serverName: string; requestedSchema?: unknown; url?: string };
  respond: (answer: { action: Action; content?: Record<string, unknown> }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const fields = request.mode === 'form' ? formFields(request.requestedSchema) : null;
  const url = request.mode === 'url' ? externalUrl(request.url) : null;
  async function send(action: Action, content?: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await respond({ action, content }); }
    catch (e) { setError(e instanceof Error ? e.message : '提交失败'); }
    finally { setBusy(false); }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields) return;
    const data = new FormData(event.currentTarget), entries: [string, unknown][] = [];
    for (const [i, field] of fields.entries()) {
      const key = String(i), raw = String(data.get(key) ?? '');
      if (raw === '' && !field.required) continue;
      let value: unknown = raw;
      if (field.type === 'array') value = data.getAll(key).map(index => field.options?.[Number(index)]?.value);
      else if (raw !== '' && field.type === 'boolean') value = raw === '0';
      else if (raw !== '' && field.options) value = field.options[Number(raw)]?.value;
      else if (raw !== '' && (field.type === 'number' || field.type === 'integer')) value = Number(raw);
      if ((raw === '' && field.options && field.type !== 'array') || !validField(field, value)) {
        setError(`请检查「${field.title || field.name}」的答案`);
        return;
      }
      entries.push([field.name, value]);
    }
    void send('accept', Object.fromEntries(entries));
  }
  return <form className="approval user-input-request" onSubmit={submit}>
    <strong>{request.serverName} 请求你的输入</strong>
    <p>{request.message}</p>
    {fields?.map((field, i) => <Field field={field} index={i} key={field.name}/>)}
    {!fields && !url && <p>此请求包含暂不支持的题型或链接，可以拒绝或取消。</p>}
    {fields && <button disabled={busy}>提交回答</button>}
    {url && <p><a href={url} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (busy) event.preventDefault();
      else void send('accept');
    }}>同意并打开 {url}</a></p>}
    <button type="button" disabled={busy} onClick={() => void send('decline')}>拒绝</button>
    <button type="button" disabled={busy} onClick={() => void send('cancel')}>取消</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
