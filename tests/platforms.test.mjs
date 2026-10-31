import test from 'node:test';
import assert from 'node:assert/strict';
import { lzLanded } from '../lib/platforms.mjs';

test('retries a transient browser error page at the original URL before changing routes', async () => {
  const url = 'https://github.com/search?q=customer&type=repositories';
  let reads = 0;
  const navigated = [];
  const operations = {
    async evaluate() {
      reads++;
      return reads < 3 ? 'about:blank' : url;
    },
    async navigate(value) {
      navigated.push(value);
    },
  };

  const landed = await lzLanded(operations, url, false);

  assert.equal(landed, url);
  assert.deepEqual(navigated, [url, url]);
});
