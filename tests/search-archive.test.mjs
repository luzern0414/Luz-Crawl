import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { edgeAvailable } from './edge-page.mjs';
import { search } from '../lib/search.mjs';
import { OperationError } from '../lib/failure.mjs';
import { rememberSite } from '../lib/memory.mjs';
import { findExperience, createTaskArchive } from '../lib/archive.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-search-'));
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('one compact search overlaps two independent full texts in real Edge', {
  skip: !edgeAvailable || process.env.LUZ_HEADLESS_INTEGRATION !== '1',
}, async () => {
  const state = path.join(temp,'fan-state'), out = path.join(temp,'fan-output');
  const cli = fileURLToPath(new URL('../scripts/luz-crawl.mjs',import.meta.url));
  let active = 0, peak = 0;
  const both = Promise.withResolvers();
  const server = http.createServer(async (req,res) => {
    const port = server.address().port;
    res.setHeader('content-type','text/html;charset=utf-8');
    if (req.url.startsWith('/search')) {
      res.end(`<main><h1>Manuals</h1><article><a href="http://localhost:${port}/docs/one">Calibration manual one</a></article>
        <article><a href="http://127.0.0.1:${port}/docs/two">Calibration manual two</a></article></main>`);
    } else if (req.url.startsWith('/docs/')) {
      peak = Math.max(peak, ++active);
      if (active === 2) both.resolve();
      const timer = setTimeout(both.resolve,4000);
      await both.promise;
      clearTimeout(timer);
      active--;
      res.end(`<main><article><h1>Calibration manual</h1><p>Independent full-text evidence for ${req.url}. This article explains the calibration procedure and the expected reading.</p></article></main>`);
    } else { res.writeHead(404); res.end(); }
  });
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await fs.mkdir(state,{recursive:true});
    await fs.writeFile(path.join(state,'sites.json'),JSON.stringify([{id:'fixture',name:'fixture',category:'custom',url:origin,domains:['localhost','127.0.0.1'],search:origin+'/search?q={query}'}]));
    const {stdout,stderr} = await promisify(execFile)(process.execPath,[cli,'search','fixture','calibration manual','--read','2',
      '--compact','--concurrency','2','--no-screenshot','--headless','--out',out], {timeout:60000,
      env:{...process.env,LUZ_CRAWL_STATE:state,LUZ_CRAWL_PROFILES:path.join(temp,'fan-edge'),LUZ_NO_BROWSER_LAUNCH:'1'}});
    const receipt = JSON.parse(stdout);
    assert.equal(peak,2);
    assert.equal(stderr,'');
    assert.equal(receipt.verified_sources,2);
    const index = JSON.parse(await fs.readFile(receipt.search_index,'utf8'));
    for (const source of index.sources) {
      assert.equal(source.browser.closed,true);
      const content = JSON.parse(await fs.readFile(path.join(source.folder,'content.json'),'utf8'));
      assert.ok(content.text.includes('Independent full-text evidence for '+new URL(source.url).pathname));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('concurrent collection searches keep the enclosing task binding and their own source indexes', async () => {
  const priorState = process.env.LUZ_CRAWL_STATE, priorThread = process.env.CODEX_THREAD_ID;
  const state = path.join(temp,'collection-binding-state');
  process.env.LUZ_CRAWL_STATE = state;
  process.env.CODEX_THREAD_ID = 'collection-thread';
  try {
    const task = await createTaskArchive(path.join(temp,'collection-binding'), 'topic', {newTask:true});
    const dirs = ['one','two'].map(name => path.join(task,'raw','collection','sources',name));
    const rows = await Promise.all(dirs.map(out => search({}, {platform:'web',query:'reference manual',read:0,out,collectionSource:true},
      {summary:()=>({})}, async (_page,opts) => {
        const folder = path.join(out,'discovery');
        await fs.mkdir(folder,{recursive:true});
        await fs.writeFile(path.join(folder,'content.json'),JSON.stringify({requested_url:opts.url,links:[{url:'https://source.example/docs/guide',text:'Reference manual'}]}));
        return {folder,status:'captured',resolved_url:opts.url,url_check:{valid_content:true},search_action:{submitted:true}};
      })));
    assert.deepEqual(rows.map(row=>row.search_archive),dirs);
    const bindings = path.join(state,'task-bindings');
    const files = await fs.readdir(bindings);
    assert.equal(files.length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(bindings,files[0]),'utf8')).folder,task);
  } finally {
    if (priorState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE=priorState;
    if (priorThread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID=priorThread;
  }
});

test('a later query can recall a public source confirmed by an earlier search', async () => {
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'source-recall');
  try {
    const url = 'https://guide.example/manual/switches?utm_source=tool';
    const unused = 'https://other.example/manual/switches';
    await search({}, { platform: 'web', query: 'keyboard switch manual', read: 1, out: path.join(temp, 'source-output') },
      { summary: () => ({}) }, async (_page, options) => {
        const folder = path.join(options.out, 'raw', options.query ? 'discovery' : 'source');
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({ requested_url: options.url, links: [
          { url, text: 'keyboard switch manual publisher reference' },
          { url: unused, text: 'keyboard switch manual other result' },
        ] }));
        return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true } };
      });
    const experience = await findExperience('keyboard switch repair manual');
    assert.deepEqual(experience.source_hints.map(hint => [hint.url, hint.source_host, hint.current_verification_required]),
      [['https://guide.example/manual/switches', 'guide.example', true]]);
    assert.equal(experience.keywords.find(hint => hint.query === 'keyboard switch manual')?.readable, 1);
  } finally {
    if (previous === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previous;
  }
});

test('discovery retains the complete observed candidate pool beyond one hundred links', async () => {
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'complete-inventory');
  try {
    const result = await search({}, { platform: 'web', query: 'research reference', read: 0, out: path.join(temp, 'many-candidates') }, { summary: () => ({}) }, async (_page, options) => {
      const folder = path.join(options.out, 'raw', 'discovery');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({
        requested_url: options.url, text: 'research reference results',
        links: Array.from({ length: 125 }, (_, i) => ({ url: `https://publisher${i}.example/research-reference`, text: `research reference ${i}` })),
      }));
      return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true } };
    });
    assert.equal(result.discovered_candidates, 125);
    assert.equal(result.candidates.length, 125);
  } finally {
    if (previous === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previous;
  }
});

test('business portals and unknown domains never silently fall back to an external index', async () => {
  const previous=process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE=path.join(temp,'native-only-state');
  try {
    await rememberSite({site:'https://unlisted.example',name:'unlisted.example'});
    // Old saved sites can still have public_index enabled; enforce the boundary at dispatch.
    const sites=JSON.parse(await fs.readFile(path.join(process.env.LUZ_CRAWL_STATE,'sites.json'),'utf8'));
    sites[0].public_index=true;
    await fs.writeFile(path.join(process.env.LUZ_CRAWL_STATE,'sites.json'),JSON.stringify(sites));
    for(const platform of ['ccgp','qcc','1688','huitun','douyin-creator','unlisted.example']) {
      const urls=[];
      const result=await search({}, {platform,query:'设备',read:0,out:path.join(temp,`native-${platform}`)}, {summary:()=>({})}, async (_page,options)=>{
        urls.push(options.url);
        const folder=path.join(options.out,'raw','discovery');
        await fs.mkdir(folder,{recursive:true});
        await fs.writeFile(path.join(folder, 'content.json'),JSON.stringify({requested_url:options.url,links:[]}));
        return {folder,status:'partial',resolved_url:options.url,url_check:{valid_content:false},search_action:{submitted:false},limitations:['no result yet']};
      });
      assert.equal(urls.length,1,platform);
      assert.ok(!urls.some(url=>new URL(url).hostname.endsWith('bing.com')),platform);
      assert.equal(result.search_status,'no_verified_candidates');
    }
  } finally {
    if(previous===undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE=previous;
  }
});

test('searches in one task reuse a single numbered folder and keep separate result files', async () => {
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.CODEX_THREAD_ID = 'parent-search-thread';
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'state');
  try {
    const out = path.join(temp, 'output');
    const operations = { summary: () => ({ browser_calls: 1 }) };
    let captures = 0;
    const capturePage = async (_page, options) => {
      const folder = path.join(options.out, 'raw', `capture-${++captures}`);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({ requested_url: options.url, links: [] }));
      return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
    };

    const first = await search({}, { platform: 'xhs', query: 'folder rule', read: 0, out }, operations, capturePage);
    const second = await search({}, { platform: 'xhs', query: 'another query', read: 0, out }, operations, capturePage);
    process.env.CODEX_THREAD_ID = 'worker-search-thread';
    const delegated = await search({}, { platform: 'xhs', query: 'delegated query', read: 0, out: first.search_archive }, operations, capturePage);
    const entries = await fs.readdir(out, { withFileTypes: true });

    assert.equal(first.search_archive, second.search_archive);
    assert.equal(first.search_archive, delegated.search_archive);
    assert.equal(path.basename(first.search_archive), '001-xhs_folder rule');
    assert.notEqual(first.search_index, second.search_index);
    assert.notEqual(second.search_index, delegated.search_index);
    assert.equal(path.dirname(first.search_index), path.join(first.search_archive, 'raw'));
    assert.equal(path.dirname(second.search_index), path.join(second.search_archive, 'raw'));
    assert.equal(path.dirname(delegated.search_index), path.join(delegated.search_archive, 'raw'));
    assert.equal(JSON.parse(await fs.readFile(first.search_index, 'utf8')).search_archive, first.search_archive);
    assert.ok(entries.length === 1 && entries.every((entry) => entry.isDirectory()));
    assert.ok(captures >= 3);
    assert.ok((await fs.readdir(path.join(first.search_archive, 'raw'))).length > 0);
    assert.ok((await fs.readdir(path.join(first.search_archive, 'raw'))).filter((name) => name.startsWith('search-')).length === 3);
    assert.ok(!(await fs.readdir(first.search_archive)).some((name) => name.startsWith('search-')));

    const explicit = path.join(temp, 'explicit-output');
    const third = await search({}, { platform: 'xhs', query: 'raw output', read: 0, out: explicit }, operations, capturePage);
    assert.equal(path.dirname(third.search_archive), explicit);
    assert.ok((await fs.readdir(explicit, { withFileTypes: true })).every((entry) => entry.isDirectory()));
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});

test('a scattered file in the output root stops the search before any browser work and is left where it is', async () => {
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'loose-state');
  try {
    const out = path.join(temp, 'loose-output');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'legacy.html'), 'keep');
    let browserCalls = 0;

    await assert.rejects(() => search({}, { platform: 'xhs', query: 'kept going', read: 0, out }, { summary: () => ({}) }, async () => { browserCalls++; throw new Error('browser unavailable'); }), /散落文件.*migrate_layout\.py/s);
    assert.equal(browserCalls, 0);
    assert.deepEqual(await fs.readdir(out), ['legacy.html']);
    assert.equal(await fs.readFile(path.join(out, 'legacy.html'), 'utf8'), 'keep');
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});

test('a failed browser route still leaves a result record in its search folder', async () => {
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'failed-state');
  try {
    const out = path.join(temp, 'failed-output');
    const result = await search({}, { platform: 'xhs', query: 'browser unavailable', read: 0, out }, { summary: () => ({}) }, async () => { throw new Error('browser unavailable'); });
    const saved = JSON.parse(await fs.readFile(result.search_index, 'utf8'));
    const entries = await fs.readdir(out, { withFileTypes: true });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /browser unavailable/);
    assert.equal(saved.search_archive, result.search_archive);
    assert.ok(entries.length === 1 && entries[0].isDirectory());
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});


test('an interrupted detail read keeps discovered candidates and the concrete stop reason', async () => {
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'interrupted-state');
  try {
    let calls = 0;
    const result = await search({}, {platform: 'x', query: 'AI tutorial', read: 1, out: path.join(temp, 'interrupted')}, {summary: () => ({})}, async (_page, options) => {
      if (++calls > 1) throw new OperationError('operation_budget', 'Local request window is exhausted');
      const folder = path.join(options.out, 'raw', '001_search');
      await fs.mkdir(folder, {recursive: true});
      await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({requested_url: options.url, links: [{url: 'https://x.com/example/status/123', text: 'AI tutorial'}]}));
      return {folder, status: 'captured', resolved_url: options.url, url_check: {valid_content: true}, search_action: {submitted: true}, limitations: []};
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.discovered_candidates, 1);
    assert.equal(result.candidates[0].url, 'https://x.com/example/status/123');
    assert.match(result.error, /Local request window/);
    assert.equal(result.stop_reason, 'operation_budget');
    const saved = JSON.parse(await fs.readFile(result.search_index, 'utf8'));
    assert.equal(saved.discovered_candidates, 1);
  } finally {
    if (previous === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previous;
  }
});

test('a dead first result leaves room for the next ranked full text and stops at the quota', async () => {
  const state = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp,'rank-backfill');
  const links = ['removed','current','extra'].map(id=>({url:`https://publisher.example/docs/${id}`,text:'Field calibration guide'}));
  const opened = [];
  try {
    const result = await search({}, { platform:'web',query:'field calibration',read:1,out:path.join(temp,'ranked-output') },
      {summary:()=>({})}, async (_page,opts) => {
        const folder=path.join(opts.out,'raw',opts.query?'discovery':'body');
        await fs.mkdir(folder,{recursive:true});
        if (opts.query) {
          await fs.writeFile(path.join(folder,'content.json'),JSON.stringify({requested_url:opts.url,links}));
          return {status:'captured',folder,resolved_url:opts.url,url_check:{valid_content:true},search_action:{submitted:true}};
        }
        opened.push(opts.url);
        return opts.url.endsWith('removed') ? {status:'blocked',folder,stop_reason:'unavailable',url_check:{valid_content:false}}
          : {status:'captured',folder,resolved_url:opts.url,url_check:{valid_content:true}};
      });
    assert.deepEqual(opened,links.slice(0,2).map(link=>link.url));
    assert.equal(result.verified_sources,1);
    assert.equal(result.status,'captured');
  } finally {
    if (state === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE=state;
  }
});

test('a readable search with no candidates is recorded as partial instead of a successful route', async () => {
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'no-candidate-state');
  try {
    const result = await search({}, { platform: 'xhs', query: 'no matching result', read: 0, out: path.join(temp, 'no-candidate') }, { summary: () => ({}) }, async (_page, options) => {
      const folder = path.join(options.out, 'raw', 'discovery');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({ requested_url: options.url, text: 'A readable search page with no matching result.', links: [] }));
      return { folder, status: 'captured', stop_reason: 'stable_after_3_scrolls', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.search_status, 'no_verified_candidates');
    const events = await fs.readdir(path.join(process.env.LUZ_CRAWL_STATE, 'events'));
    const event = JSON.parse(await fs.readFile(path.join(process.env.LUZ_CRAWL_STATE, 'events', events[0]), 'utf8'));
    assert.equal(event.status, 'partial');
    assert.equal(event.candidates, 0);
  } finally {
    if (previous === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previous;
  }
});

test('candidate discovery remains successful when the search page ends at its scroll budget', async () => {
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'budget-candidate-state');
  try {
    const result = await search({}, { platform: 'xhs', query: 'useful result', read: 0, out: path.join(temp, 'budget-candidate') }, { summary: () => ({}) }, async (_page, options) => {
      const folder = path.join(options.out, 'raw', 'discovery');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({ requested_url: options.url, text: 'A readable search page with a useful result.', links: [{ url: 'https://www.xiaohongshu.com/explore/abc123', text: 'useful result' }] }));
      return { folder, status: 'partial', stop_reason: 'scroll_budget', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: ['scroll budget'] };
    });
    assert.equal(result.discovered_candidates, 1);
    assert.equal(result.status, 'captured');
    assert.equal(result.discovery_status, 'partial');
    assert.equal(result.search_status, 'candidates_found');
  } finally {
    if (previous === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previous;
  }
});
