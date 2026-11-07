import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImages, decodeFiles } from '../server/images.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=';
test('image input validates format, size, count and base64 without accepting paths', () => {
  assert.equal(decodeImages([png])[0].extension, 'png');
  assert.deepEqual(decodeImages(), []);
  for (const invalid of [[png.repeat(2)], ['/workspace/private.png'], ['data:image/svg+xml;base64,PHN2Zy8+'], ['data:image/png;base64,YWJj'], Array(5).fill(png), {}, [null]]) {
    assert.throws(() => decodeImages(invalid));
  }
  const large = Buffer.alloc(2 * 1024 * 1024 + 1);
  Buffer.from('89504e470d0a1a0a','hex').copy(large);
  assert.throws(() => decodeImages(['data:image/png;base64,' + large.toString('base64')]), error => error.status === 413);
});

test('file attachments sanitize names and validate payloads and disguised images', () => {
  const file = { name: '../中文/报告.txt', data: 'data:application/octet-stream;base64,5Lit5paH' };
  const decoded = decodeFiles([file])[0];
  assert.equal(decoded.name, '_中文_报告.txt');
  assert.equal(decoded.bytes.toString('utf8'), '中文');
  assert.equal(decoded.image, false);
  assert.equal(decodeFiles([{ name: '照片.png', data: png }])[0].image, true);
  assert.equal(decodeFiles([{ name: '照片.txt', data: png }])[0].name, '照片.txt.png');
  assert.equal(decodeFiles([{ name: '空文件.txt', data: 'data:application/octet-stream;base64,' }])[0].bytes.length, 0);
  for (const files of [[{ ...file, name: '..' }], [{ ...file, name: '中'.repeat(100) }], [{ ...file, data: '/workspace/private' }], [{ ...file, name: '伪装.png' }], Array(5).fill(file), [null]]) {
    assert.throws(() => decodeFiles(files));
  }
  assert.throws(() => decodeFiles([{ ...file, data: 'data:application/octet-stream;base64,' + Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }]), error => error.status === 413);
});
