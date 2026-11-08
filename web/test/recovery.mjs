import assert from 'node:assert/strict';
throw new Error('旧恢复验收已停用，禁止用于生产桌面；请使用共享模式的隔离验收');
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cookie = '';
const checks = [];
async function request(url, method = 'GET', body) {
  const res = await fetch('http://127.0.0.1:3000/api' + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  assert.ok(res.ok, JSON.stringify(json));
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
  return json;
}
async function until(fn) {
  for (let i=0;i<100;i++) { try { if (await fn()) return; } catch {} await new Promise(r=>setTimeout(r,500)); }
  throw new Error('Recovery timed out');
}
async function docker(args) {
  await new Promise((resolve,reject)=>{
    const p=spawn('docker',args,{cwd:path.dirname(web),stdio:'pipe'});let text='';
    p.stderr.on('data',b=>text+=b);p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error(text)));
  });
}
let project;
try {
  await until(async()=>{try{return(await fetch('http://127.0.0.1:3000')).ok}catch{return false}});
  const username='recovery_'+Date.now().toString(36);
  await request('/auth/register','POST',{username,password:'Recovery-test-2026'});
  await request('/auth/login','POST',{username,password:'Recovery-test-2026'});
  await until(async()=>(await request('/status')).connected);
  project=(await request('/projects','POST',{name:'故障恢复验收'})).project;
  const session=(await request(`/projects/${project.id}/sessions`,'POST',{name:'未发送消息的空会话'})).session;
  const base=`/projects/${project.id}/sessions/${session.id}`;
  assert.equal((await request(base+'/history')).turns.length,0);
  const before=await request('/status');
  await docker(['compose','-f','docker-compose.yaml','restart','mqtt']);
  await until(async()=>(await request('/status')).connected);
  assert.equal((await request(base+'/history')).turns.length,0);
  checks.push('Broker restart reconnects and empty history stays readable');
  await docker(['compose','-f','docker-compose.yaml','restart','codex-app-server']);
  await until(async()=>{const s=await request('/status');return s.connected && s.runId!==before.runId});
  assert.equal((await request(base+'/history')).turns.length,0);
  const current=(await request('/projects')).projects.find(p=>p.id===project.id).sessions[0];
  assert.notEqual(current.threadId,session.threadId);
  checks.push('Empty session recreated safely after app-server restart');
  await request(base,'DELETE');await request(`/projects/${project.id}`,'DELETE');
  checks.push('Recovered session and project delete cleanly');
  console.log(checks.map(s=>'PASS '+s).join('\n'));
  await mkdir(path.join(web,'test-results'),{recursive:true});
  await writeFile(path.join(web,'test-results/recovery.json'),JSON.stringify({passed:true,checks},null,2),'utf8');
}catch(e){console.error('FAIL',e.message);process.exitCode=1;}
