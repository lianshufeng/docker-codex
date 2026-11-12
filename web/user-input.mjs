// Matches Codex's desktop/TUI async-question reply envelope.
const start = '<send_user_message_question_reply>';
const end = '</send_user_message_question_reply>';

export function questionKey(itemId, index) {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

export function parseQuestionReply(text) {
  if (typeof text !== 'string') return null;
  let content = text.trim();
  const idePrefix = '# Context from my IDE setup:\n';
  const requestMarker = '\n## My request for Codex:\n';
  if (content.startsWith(idePrefix) && content.includes(requestMarker)) content = content.slice(content.lastIndexOf(requestMarker) + requestMarker.length).trim();
  if (!content.startsWith(start) || !content.endsWith(end)) return null;
  try {
    const value = JSON.parse(content.slice(start.length, -end.length));
    const replies = Array.isArray(value) ? value : [value];
    return replies.length && replies.every(reply => typeof reply?.questionItemId === 'string' &&
      typeof reply.question === 'string' && typeof reply.answer === 'string') ? replies : null;
  } catch { return null; }
}

export function pendingQuestions(items) {
  const pending = new Map();
  for (const item of items) {
    if (item.type === 'userMessage') {
      const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const replies = parseQuestionReply(text);
      if (replies) for (const reply of replies) pending.delete(reply.questionItemId);
      else pending.clear();
    }
    if (item.type === 'agentMessage' && Array.isArray(item.questions)) {
      item.questions.forEach((question, index) => {
        if (typeof question.title !== 'string' || !question.title.trim()) return;
        const id = questionKey(item.id, index);
        const options = Array.isArray(question.options) ? question.options.filter(option => typeof option === 'string') : [];
        pending.set(id, { id, itemId: item.id, index, title: question.title, options });
      });
    }
  }
  return [...pending.values()];
}

export function questionReply(question, answer) {
  const title = new TextDecoder().decode(new TextEncoder().encode(question.title).slice(0, 512)).replace(/\ufffd$/, '').replace(/[\r\n]/g, ' ');
  return `${start}\n${JSON.stringify([{ questionItemId: question.id, question: title, answer }])}\n${end}`;
}

export function normalizeAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('回答格式无效');
  const ids = new Set(questions.map(question => question.id));
  if (Object.keys(answers).some(id => !ids.has(id))) throw new Error('回答包含未知问题');
  return Object.fromEntries(Object.entries(answers).map(([id, value]) => {
    // Accept the previous Web request shape while clients reload after an upgrade.
    const list = typeof value === 'string' ? [value] : value?.answers;
    if (!Array.isArray(list) || list.some(answer => typeof answer !== 'string' || !answer.trim())) {
      throw new Error('请检查答案内容');
    }
    const question = questions.find(question => question.id === id);
    if (question.options?.length && list.length && !question.isOther &&
      !question.options.some(option => option.label === list[0]) && !list[0].startsWith('user_note: ')) {
      throw new Error('请选择有效选项或填写补充说明');
    }
    return [id, { answers: list }];
  }));
}
