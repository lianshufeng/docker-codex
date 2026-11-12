// Deterministic Responses SSE provider for the isolated app-server acceptance.
const http = require('node:http');
const { randomUUID } = require('node:crypto');

http.createServer(async (request, response) => {
  if (request.url === '/health') return response.end('ok');
  if (request.url.endsWith('/models')) {
    return response.end(JSON.stringify({ data: [{ id: 'gpt-5.4', object: 'model' }] }));
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); }
  catch { response.writeHead(400).end(); return; }
  const id = randomUUID(), input = body.input || [];
  const latestIndex = input.findLastIndex(item => item.role === 'user');
  const latest = input[latestIndex];
  const prompt = latest?.content?.map(part => part.text).join(' ') || '';
  const mode = prompt.includes('INPUT_ASYNC') ? 'async' : prompt.includes('INPUT_SYNC') ? 'sync' : '';
  const answered = input.slice(latestIndex + 1).findLast(item => item.type === 'function_call_output');
  const options = [{ label: '浅色', description: '白色背景' }, { label: '深色', description: '黑灰背景' }];
  const syncQuestions = [
    { id: 'theme', header: '外观', question: '请选择外观', options, isOther: true },
    { id: 'secret', header: '测试', question: '请填写补充说明', options: [{ label: '测试说明', description: '可以补充文本' }], isOther: true },
  ];
  const asyncQuestions = [{ title: '请选择异步外观', options: ['浅色', '深色'] }];
  const callId = `call-${mode}-${id}`;
  const call = mode && !answered;
  const item = call ? { type: 'function_call', call_id: callId, name: mode === 'async' ? 'request_user_input_async' : 'request_user_input',
    arguments: JSON.stringify({ questions: mode === 'async' ? asyncQuestions : syncQuestions }) }
    : { type: 'message', role: 'assistant', id: `message-${id}`, phase: 'final_answer', content: [{ type: 'output_text', text:
      prompt.includes('<send_user_message_question_reply>') ? '异步回答已到达模型接口：' + prompt
        : answered ? '工具结果已到达模型接口：' + JSON.stringify(answered.output) : '验收消息已到达模型接口' }] };
  console.log(JSON.stringify({ mode, requestedTool: call ? item.name : null,
    advertised: call ? JSON.stringify(body.tools || []).includes(`"${item.name}"`) : undefined,
    answerReceived: Boolean(answered || prompt.includes('<send_user_message_question_reply>')) }));
  const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }];
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}).listen(38119, '0.0.0.0');
