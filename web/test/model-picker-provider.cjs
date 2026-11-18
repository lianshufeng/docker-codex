// 用于隔离验收的可控 Responses SSE 服务。
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const captured = [];
http.createServer(async (request, response) => {
  if (request.url === '/captured') return response.end(JSON.stringify(captured));
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) return response.writeHead(404).end();
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const text = body.input.findLast(item => item.role === 'user')?.content?.map(part => part.text).join(' ');
  captured.push({ path: request.url, model: body.model, effort: body.reasoning?.effort, text });
  const id = randomUUID();
  const item = { type: 'message', role: 'assistant', id: `message-${id}`, phase: 'final_answer',
    content: [{ type: 'output_text', text: '隔离模型已响应' }] };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'response.created', response: { id } });
  if (text?.includes('HOLD')) await new Promise(resolve => setTimeout(resolve, 8000));
  send({ type: 'response.output_item.done', item });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id,
    usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 } } })}\n\n`);
}).listen(38119, '0.0.0.0');
