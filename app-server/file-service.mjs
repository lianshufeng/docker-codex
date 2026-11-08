import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function fileService(client, base) {
  let worker;
  const pending = new Set();
  function start() {
    worker = spawn('python', [new URL('./file_transfer.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: worker.stdout }).on('line', line => {
      const reply = JSON.parse(line);
      pending.delete(reply.id);
      client.publish(`${base}/files/reply/${reply.id}`, Buffer.from(reply.payload, 'base64'), { qos: 1, retain: false });
    });
    worker.on('error', error => console.error('file_service', error.message));
    worker.on('close', () => { worker = undefined; pending.clear(); });
    worker.stdin.on('error', error => console.error('file_service_input', error.message));
  }
  return {
    accept(topic, payload, packet) {
      if (!topic.startsWith(`${base}/files/request/`)) return false;
      const id = topic.slice(`${base}/files/request/`.length);
      if (packet.retain || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || payload.length > 540672) return true;
      if (!worker) start();
      pending.add(id);
      worker.stdin.write(JSON.stringify({ id, payload: payload.toString('base64') }) + '\n');
      return true;
    },
    close() { worker?.kill('SIGTERM'); },
  };
}
