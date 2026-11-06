import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImages } from '../server/images.mjs';

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
