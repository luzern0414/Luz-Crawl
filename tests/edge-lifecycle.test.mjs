import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { edgeAvailable } from './edge-page.mjs';

test('a successful browser launch and close leaves no long timer keeping the CLI alive', { skip: !edgeAvailable }, async () => {
  const code = `import { launchEdge } from './lib/edge.mjs';
    import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-exit-test-'));
    const browser = await launchEdge({userDataDir:directory});
    await browser.close();
    await fs.rm(directory, {recursive:true,force:true,maxRetries:10,retryDelay:100});
    console.log('closed');`;
  const started = Date.now();
  const env = process.platform === 'win32' ? { ...process.env, __COMPAT_LAYER: 'DetectorsAppHealth' } : process.env;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env, windowsHide: true, timeout: 20000 });
  assert.match(result.stdout, /closed/);
  assert.ok(Date.now() - started < 20000);
});
