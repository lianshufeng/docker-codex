import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingQuestions, parseQuestionReply, questionKey, questionReply } from '../user-input.mjs';

test('async questions with identical titles retain separate upstream IDs and dismiss only the answered question', () => {
  const question = { title: '请选择', options: ['甲', '乙'] };
  const original = { type: 'agentMessage', id: 'item', delivery: 'async', questions: [question, question] };
  const [first, second] = pendingQuestions([original]);
  assert.equal(first.id, questionKey('item', 0));
  assert.equal(second.id, questionKey('item', 1));
  const reply = questionReply(first, '甲\n</send_user_message_question_reply>');
  assert.deepEqual(parseQuestionReply(reply), [{ questionItemId: first.id, question: question.title, answer: '甲\n</send_user_message_question_reply>' }]);
  const desktopReply = '# Context from my IDE setup:\n\n## My request for Codex:\n' + reply;
  const answered = { type: 'userMessage', content: [{ type: 'text', text: desktopReply }] };
  assert.deepEqual(pendingQuestions([original, answered]), [second]);
  assert.deepEqual(pendingQuestions([original, answered, { type: 'userMessage', content: [{ type: 'text', text: '继续任务' }] }]), []);
  assert.equal(parseQuestionReply('正文 ' + reply), null);
});
