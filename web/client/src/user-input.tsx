import React, { useEffect, useId, useRef, useState } from 'react';
import './user-input.css';

export type InputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
};

type Draft = { selected?: string; note?: string };
export type QuestionDraft = { index: number; answers: Map<string, Draft>; requestId?: string; submitted?: boolean; startedAt?: number; touched?: boolean; answer?: string };
export type Answers = Record<string, { answers: string[] }>;

export function UserInputRequest({ questions, draft, blocking, disabled, onSubmit, onSkip }: {
  questions: InputQuestion[];
  draft: QuestionDraft;
  blocking: boolean;
  disabled: boolean;
  onSubmit: (answers: Answers) => Promise<void>;
  onSkip?: () => void;
}) {
  const titleId = useId(), inFlight = useRef(false);
  const [index, setIndex] = useState(draft.index);
  const [answers, setAnswers] = useState(draft.answers);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (blocking || onSkip || disabled || draft.touched) { setRemaining(null); return; }
    draft.startedAt ??= Date.now();
    let attempted = false;
    const tick = async () => {
      if (draft.touched || attempted) { setRemaining(null); return; }
      const elapsed = Date.now() - draft.startedAt!;
      setRemaining(elapsed >= 60000 ? Math.max(0, Math.ceil((120000 - elapsed) / 1000)) : null);
      if (elapsed < 120000 || inFlight.current) return;
      attempted = true; inFlight.current = true; setBusy(true);
      try { await onSubmit({}); }
      catch { draft.touched = true; setRemaining(null); setError('自动跳过结果待确认，请重新同步问题状态。'); }
      finally { inFlight.current = false; setBusy(false); }
    };
    const timer = setInterval(() => { void tick(); }, 1000);
    return () => clearInterval(timer);
  }, [blocking, disabled, draft, onSkip, onSubmit]);
  const question = questions[index];
  if (!question) return <p className="question-card">此问题格式暂不支持。</p>;
  const value = answers.get(question.id) || {};
  const options = question.options || [];
  const update = (change: Draft) => {
    draft.touched = true; setRemaining(null);
    const next = new Map(answers).set(question.id, { ...value, ...change });
    draft.answers = next;
    setAnswers(next);
  };
  const move = (next: number) => { draft.touched = true; setRemaining(null); draft.index = next; setIndex(next); };
  function reply(q: InputQuestion) {
    const value = answers.get(q.id), selected = value?.selected, note = value?.note?.trim();
    if (onSkip) return [note || selected].filter((text): text is string => Boolean(text));
    return [...(selected ? [selected] : []), ...(note ? [`user_note: ${note}`] : [])];
  }
  async function submit(skip: boolean) {
    if (inFlight.current) return;
    if (skip && onSkip) { onSkip(); return; }
    if (disabled) return;
    draft.touched = true; setRemaining(null);
    if (index < questions.length - 1) {
      if (skip) update({ selected: undefined, note: undefined });
      move(index + 1);
      return;
    }
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      await onSubmit(Object.fromEntries(questions.map(q => [q.id, { answers: skip && q === question ? [] : reply(q) }])));
    } catch (e: any) {
      setError([503, 504].includes(e.status) || !e.status ? '提交结果待确认，请等连接恢复后查看问题状态。' : e.message);
    } finally { inFlight.current = false; setBusy(false); }
  }
  const canWrite = !options.length || question.isOther || !onSkip;
  return <form className="question-card" aria-labelledby={titleId} onSubmit={event => { event.preventDefault(); void submit(false); }}>
    <header><strong id={titleId}>{blocking ? '等待你的回答' : '问题'}</strong>{questions.length > 1 && <span>第 {index + 1} / {questions.length} 题</span>}</header>
    <fieldset disabled={busy || disabled}>
      <legend>{question.header && <small>{question.header}</small>}{question.question}</legend>
      {options.map((option, i) => <label key={i} className="question-option">
        <input type="radio" name={titleId} checked={value.selected === option.label}
          onChange={() => update({ selected: option.label, ...(onSkip ? { note: undefined } : {}) })}/>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {canWrite && <label className="question-note">{options.length ? (question.isOther ? '自行填写或补充说明' : '补充说明') : '填写回答'}
        <input value={value.note || ''} type={question.isSecret ? 'password' : 'text'} autoComplete="off" maxLength={16000}
          onChange={event => update({ note: event.target.value, ...(onSkip ? { selected: undefined } : {}) })}/>
      </label>}
    </fieldset>
    {disabled && <p role="status">暂时无法提交，请等待问题同步或当前任务结束。</p>}
    {remaining !== null && <p role="status">{remaining} 秒后自动跳过，选择或填写后保留此问题。</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <footer>
      {index > 0 && <button type="button" className="secondary" disabled={busy} onClick={() => move(index - 1)}>上一题</button>}
      <button type="button" className="secondary" disabled={busy || (disabled && !onSkip)} onClick={() => void submit(true)}>跳过</button>
      <button className="primary" disabled={busy || disabled || !reply(question).length}>{busy ? '提交中…' : index < questions.length - 1 ? '下一题' : '发送'}</button>
    </footer>
  </form>;
}
