import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { batch, readBatch, batchConcurrency, batchReceipt } from '../lib/batch.mjs';
import { OperationError } from '../lib/failure.mjs';
import vm from 'node:vm';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-batch-'));
test.after(() => fs.rm(tmp, { recursive: true, force: true }));
async function options(name, jobs, extra = {}) {
  const file = path.join(tmp, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(jobs));
  return { file, out: path.join(tmp, name), ...extra };
}

test('fallback starts before an unrelated slow site settles and its finished checkpoint is readable', async () => {
  const opts = await options('immediate-fallback', [
    {id:'q',platform:'a.test',query:'guide',fallbacks:['b.test']}, 'https://slow.test/docs'
  ], {concurrency:2});
  const events=[];
  const {promise,resolve}=Promise.withResolvers();
  const timeout=setTimeout(resolve,1500);
  try {
    const result=await batch(opts,async(kind,job)=>{
      if(kind==='capture') { await promise; events.push('slow done'); return {status:'captured'}; }
      if(job.platform==='a.test') return {status:'partial',candidates:[]};
      const dir=path.join(opts.out,'raw');
      const name=(await fs.readdir(dir)).find(file=>file.endsWith('.json'));
      const running=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
      const checkpoint=JSON.parse((await fs.readFile(running.progress_file,'utf8')).trim());
      assert.equal(checkpoint.row.platform,'a.test');
      events.push('fallback started'); resolve();
      return {status:'partial',candidates:[{url:'https://source.test/docs'}],sources:[{status:'awaiting_user',task_id:'source-task',awaiting_reason:'login_required'}]};
    });
    assert.deepEqual(events,['fallback started','slow done']);
    assert.deepEqual((await batchReceipt(result)).awaiting_user,[{id:'q',task_id:'source-task',reason:'login_required'}]);
    assert.equal((await fs.readdir(path.dirname(result.batch_file))).some(name=>name.endsWith('.jsonl')),false);
  } finally {clearTimeout(timeout);}
});

test('batch bounds simultaneous pages, serializes a site and preserves input order and evidence', async () => {
  const settings = await options('parallel', ['https://a.test/1', 'https://a.test/2', 'https://b.test/1', 'https://c.test/1', 'https://d.test/1'], { concurrency: 3 });
  const active = new Set(), events = [];
  let peak = 0;
  const result = await batch(settings, async (kind, opts) => {
    const host = new URL(opts.url).hostname;
    assert(!active.has(host)); active.add(host); peak = Math.max(peak, active.size);
    assert.equal(kind, 'capture'); assert.equal(opts.park_on_block, true); assert.equal(opts.window, 'background');
    events.push(opts.url);
    await new Promise(resolve => setImmediate(resolve));
    active.delete(host);
    return { status: 'captured', browser: { owned: true, closed: true } };
  });
  assert.equal(peak, 3); assert.equal(result.status, 'completed'); assert.equal(result.attempted, 5);
  assert(events.indexOf('https://a.test/1') < events.indexOf('https://a.test/2'));
  assert.deepEqual(result.results.map(row => row.url), ['https://a.test/1', 'https://a.test/2', 'https://b.test/1', 'https://c.test/1', 'https://d.test/1']);
  assert.deepEqual(JSON.parse(await fs.readFile(result.batch_file, 'utf8')), result);
});

test('login skips queued pages on that site while independent sites and failures settle', async () => {
  const settings = await options('blocked', ['https://a.test/login', 'https://a.test/2', 'https://b.test/1', 'https://c.test/1']);
  const visited = [];
  const result = await batch(settings, async (_, opts) => {
    visited.push(opts.url);
    if (opts.url.includes('a.test')) return { status: 'awaiting_user', stop_reason: 'verification_required', task_id: 'saved', browser: { closed: true, parked: true } };
    if (opts.url.includes('b.test')) throw new Error('offline');
    return { status: 'captured' };
  });
  assert.equal(result.status, 'partial'); assert.equal(result.attempted, 3); assert.equal(result.settled, 4);
  assert(!visited.includes('https://a.test/2'));
  assert.equal(result.results[1].blocked_by, 'verification_required');
  assert.equal(result.results[2].error, 'offline'); assert.equal(result.results[3].status, 'captured');
});

test('batch validates the whole plan and write authorization before executing any page', async () => {
  let attempted = 0;
  const execute = async () => { attempted++; return { status: 'completed' }; };
  async function check(name, jobs, extra, pattern) {
    const settings = await options(name, jobs, extra);
    await assert.rejects(() => batch(settings, execute), pattern);
  }
  await check('scheme', ['https://a.test/', 'file:///private'], {}, /HTTP/);
  await check('credentials', ['https://user:pass@a.test/'], {}, /credentials/);
  await check('override', [{ url: 'https://a.test/', out: 'elsewhere' }], {}, /only id/);
  await check('write', [{ url: 'https://a.test/', steps: [{ action: 'type', selector: '#q', text: '设备' }] }], {}, /allow-write/);
  assert.equal(attempted, 0);
  const settings = await options('actions', [{ id: 'search', url: 'https://a.test/', steps: [{ action: 'read' }] }]);
  const jobs = await readBatch(settings); assert.equal(jobs[0].id, 'search');
  assert.equal(batchConcurrency(), 6);
  assert.equal(batchConcurrency(8), 8);
  for (const value of [0, 9, 1.5, 'bad']) assert.throws(() => batchConcurrency(value), /1 to 8/);
  const result = await batch(settings, async (kind, opts) => { assert.equal(kind, 'browser'); assert.equal(opts.steps[0].action, 'read'); return { status: 'completed' }; });
  assert.equal(result.status, 'completed');
});

test('thrown cooldowns keep their failure code and stop the queued site', async () => {
  const settings = await options('thrown-cooldown', ['https://a.test/1', 'https://a.test/2', 'https://b.test/1']);
  const visited = [];
  const result = await batch(settings, async (_, opts) => {
    visited.push(opts.url);
    if (opts.url.includes('a.test')) throw new OperationError('rate_limited', 'HTTP 429', { retry_after_ms: 600000 });
    return { status: 'captured' };
  });
  assert.equal(result.results[0].failure.code, 'rate_limited');
  assert.equal(result.results[0].failure.retry_after_ms, 600000);
  assert.equal(result.results[1].status, 'skipped');
  assert(!visited.includes('https://a.test/2'));
  assert.equal(result.results[2].status, 'captured');
  assert.deepEqual(JSON.parse(await fs.readFile(result.batch_file, 'utf8')), JSON.parse(JSON.stringify(result)));
});

test('different site filters and a page on the search host share its cooldown', async () => {
  const settings = await options('search-lanes', [
    { platform: 'Bing', query: 'one', site: 'a.example', read: 2 },
    { platform: 'bing', query: 'two', site: 'b.example' },
    { url: 'https://www.bing.com/search' }, { url: 'https://independent.example/guide' },
  ]);
  const result = await batch(settings, async (kind, opts) => {
    assert.equal(opts.deferSummary, true);
    if (kind === 'search') return { status: 'blocked', stop_reason: 'rate_limited' };
    return { status: 'captured' };
  });
  assert.deepEqual(result.results.map(row => row.status), ['blocked', 'skipped', 'skipped', 'captured']);
  assert.equal(result.results[0].site, 'a.example');
  assert.equal(result.results[0].read, 2);
  assert.equal(result.results[1].blocked_by, 'rate_limited');
});

test('search fallbacks stay in one batch and only run for an unproductive route', async () => {
  const settings = await options('fallbacks', [
    { id: 'empty', platform: 'bing', query: 'empty', fallbacks: ['baidu'], read: 0, screenshot: false },
    { id: 'hit', platform: 'bing', query: 'hit', fallbacks: ['baidu'], read: 0 },
    { id: 'limited', platform: 'qwant', query: 'limited', fallbacks: ['baidu'] },
    { id: 'known', url: 'https://docs.test/reference' },
  ]);
  const seen = [];
  const result = await batch(settings, async (kind, opts) => {
    assert.equal(opts.deferSummary, true);
    if (kind === 'capture') return { status: 'captured', url_check: { valid_content: true, requested: opts.url } };
    seen.push([opts.platform, opts.query]);
    if (opts.query === 'limited') return { status: 'blocked', stop_reason: 'rate_limited' };
    if (opts.query === 'empty') assert.equal(opts.screenshot, false);
    const candidates = opts.platform === 'bing' && opts.query === 'empty' ? [] : [{ url: 'https://docs.test/reference?utm_campaign=search' }];
    return { status: candidates.length ? 'captured' : 'partial', search_performed: true, candidates };
  });
  assert.deepEqual(result.results.map(row => [row.id, row.platform || row.url]), [
    ['empty', 'baidu'], ['hit', 'bing'], ['limited', 'qwant'], ['known', 'https://docs.test/reference'],
  ]);
  assert.deepEqual(seen.filter(([platform]) => platform === 'baidu'), [['baidu', 'empty']]);
  assert.equal(result.results[0].previous_routes[0].platform, 'bing');
  assert.equal(result.results[0].previous_routes[0].search_performed, true);
});

test('compact batch output reports counts and pending tasks without carrying raw results', async () => {
  const { batchReceipt } = await import('../lib/batch.mjs');
  const settings = await options('return-once', [
    { platform: 'bing', query: 'one' }, { platform: 'baidu', query: 'two' }, { url: 'https://docs.test/login' },
  ]);
  const result = await batch(settings, async (kind, opts) => kind === 'search'
    ? { status: 'captured', search_performed: true, candidates: [{ url: 'https://docs.test/one?utm_medium=' + opts.platform, text: 'candidate detail '.repeat(1000) }] }
    : { status: 'awaiting_user', awaiting_reason: 'login_required', task_id: 'saved' });
  const receipt = await batchReceipt(result);
  assert.equal(receipt.queries_executed, 2);
  assert.equal(receipt.candidate_count, 1);
  assert.equal(receipt.settled, 3);
  assert.equal(receipt.awaiting_user[0].task_id, 'saved');
  assert.match(receipt.batch_sha256, /^[0-9a-f]{64}$/);
  assert(!('results' in receipt));
  assert(!JSON.stringify(receipt).includes('candidate detail'));
  assert(JSON.stringify(receipt).length < 1400);
  assert.equal(JSON.parse(await fs.readFile(receipt.batch_file, 'utf8')).results.length, 3);
});

test('the native batch keeps its resolved output even if browser preferences change during child runs', async () => {
  const settings = await options('native-output', ['https://a.test/', 'https://b.test/']);
  const source = await fs.readFile(new URL('../lib/commands.mjs', import.meta.url), 'utf8');
  const functions = ['run', 'runBatch'].map(name => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  const outputs = []; let synced = 0;
  const runBatch = vm.runInNewContext(functions + '\nrunBatch', {
    process, defaults: { browser_profile: 'saved-profile' }, profileFromArgs: value => value,
    syncBrowserPreferences: async () => ({ output_dir: ++synced === 1 ? settings.out : path.join(tmp, 'changed-output') }),
    findTaskArchive: async folder => ({ folder }), readBatch, batch,
    lzLibrary: async () => {}, lzScope: async () => {},
    withBrowser: async (_, values) => { outputs.push(values.out); return { status: 'captured', browser: { owned: true, closed: true } }; },
  });
  const result = await runBatch({ file: settings.file });
  assert.equal(result.status, 'completed'); assert.equal(synced, 1);
  assert.deepEqual(outputs, [settings.out, settings.out]);
});
