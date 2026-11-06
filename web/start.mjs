// Install and build only when inputs change; Compose remains a single Node service.
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function command(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} failed: ${code}`)));
  });
}
async function hashFiles(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(file));
  return hash.digest('hex');
}
async function filesIn(dir) {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(file)); else result.push(file);
  }
  return result;
}
const lockHash = await hashFiles(['package.json','package-lock.json']);
const installMarker = 'node_modules/.web-lock-hash';
if (!await exists(installMarker) || (await readFile(installMarker,'utf8')) !== lockHash) {
  await command(['ci','--no-audit','--no-fund']); await writeFile(installMarker,lockHash,'utf8');
}
const sourceHash = await hashFiles(['package-lock.json','vite.config.mjs',...await filesIn('client')]);
const buildMarker = 'dist/.web-source-hash';
if (!await exists('dist/index.html') || !await exists(buildMarker) || (await readFile(buildMarker,'utf8')) !== sourceHash) {
  await command(['run','build']); await writeFile(buildMarker,sourceHash,'utf8');
}
await import('./server/index.mjs');
