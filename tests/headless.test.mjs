import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { retryVisibleIfIncomplete, visibleFallbackReason, withHeadlessSession, withVisibleFallbackOnHeadlessStartFailure } from '../lib/headless.mjs';
import { browserProxy, edgeUserAgent } from '../lib/edge.mjs';
import { edgeAvailable, openTestBrowser } from './edge-page.mjs';
import { extractPage, submitSearch } from '../lib/extract-page.mjs';
import { domOperation, BrowserOperations } from '../lib/browser-operations.mjs';
import { rememberPreferences } from '../lib/memory.mjs';
import { testPolicy } from './helpers.mjs';

test('the silent Edge announces a desktop identity; proxies pass without credentials', { skip: !edgeAvailable }, () => {
  assert.match(edgeUserAgent(), /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .* Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36 Edg\/\1\.0\.0\.0$/);
  assert.doesNotMatch(edgeUserAgent(), /Headless/);
  assert.deepEqual(browserProxy({ HTTPS_PROXY: 'http://127.0.0.1:7897' }), { server: 'http://127.0.0.1:7897', bypass: 'localhost;127.0.0.1;[::1]' });
  assert.throws(() => browserProxy({ HTTPS_PROXY: 'http://user:pass%21@127.0.0.1:7897' }), /user name and password/);
  assert.throws(() => browserProxy({ HTTPS_PROXY: 'file:///private' }));
  assert.equal(browserProxy({}), undefined);
});

test('an unauthorized headless action is rejected before creating a browser profile', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-headless-validation-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/luz-crawl.mjs', import.meta.url)), 'browser', 'https://example.com', '--headless', '--steps', JSON.stringify([{action:'click',selector:'button'}])], { windowsHide: true, env:{...process.env,LUZ_CRAWL_STATE:directory} }), error => Boolean(error.stdout?.includes('allow-write')));
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await fs.rm(directory, {recursive:true,force:true}); }
});


test('an unsupported browser is rejected before opening a profile or running the operation', async () => {
  let called = false;
  await assert.rejects(withHeadlessSession(() => { called = true; }, { browser: '../outside' }), /Microsoft Edge only/);
  assert.equal(called, false);
});

test('incomplete headless reads retry once in the saved foreground profile, but cooldowns never switch routes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-visible-fallback-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  const previousProfile = process.env.LUZ_HEADLESS_PROFILE;
  const previousVisibleFallback = process.env.LUZ_VISIBLE_FALLBACK;
  process.env.LUZ_CRAWL_STATE = directory;
  process.env.LUZ_HEADLESS_PROFILE = 'headless-profile';
  try {
    await rememberPreferences({ profile: 'saved-edge-profile' });
    const calls = [];
    const partial = { status: 'partial', stop_reason: 'target_body_not_found', url_check: { valid_content: false }, browser: { context_id: 'headless-profile' } };
    const result = await retryVisibleIfIncomplete(async options => { calls.push(options); assert.equal(process.env.LUZ_VISIBLE_FALLBACK, '1'); return { status: 'captured', url_check: { valid_content: true } }; }, { profile: 'headless-alias', window: 'background', url: 'https://www.xiaohongshu.com/explore/example' }, partial);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, 'saved-edge-profile');
    assert.equal(calls[0].window, 'background');
    assert.equal(calls[0].resume, true);
    assert.equal(calls[0]._luz_visible_fallback, true);
    assert.equal(result.status, 'captured');
  assert.equal(result.visible_fallback.visible_window, 'background');
  assert.equal(result.headless_fallback.visible_window, 'background');
  assert.equal(visibleFallbackReason({ status: 'awaiting_user', stop_reason: 'login_required' }), 'visible_login_required');
    assert.equal(visibleFallbackReason({ status: 'partial', stop_reason: 'rate_limited' }), null);
    assert.equal(visibleFallbackReason({ status: 'blocked', stop_reason: 'operation_budget' }), null);
    const limited = { status: 'blocked', stop_reason: 'rate_limited' };
    assert.strictEqual(await retryVisibleIfIncomplete(() => { throw new Error('must not retry'); }, {}, limited), limited);
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    if (previousProfile === undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE = previousProfile;
    if (previousVisibleFallback === undefined) delete process.env.LUZ_VISIBLE_FALLBACK; else process.env.LUZ_VISIBLE_FALLBACK = previousVisibleFallback;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a disconnected saved profile selects a connected browser before attempting the site', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-stale-visible-profile-'));
  const priorState = process.env.LUZ_CRAWL_STATE, priorHeadless = process.env.LUZ_HEADLESS_PROFILE;
  process.env.LUZ_CRAWL_STATE = directory; process.env.LUZ_HEADLESS_PROFILE = 'silent-profile';
  try {
    await rememberPreferences({profile:'disconnected-profile'});
    const calls = [];
    const result = await retryVisibleIfIncomplete(async options => {
      calls.push(options.profile);
      return options.profile === 'disconnected-profile'
        ? {status:'failed',stop_reason:'unavailable',error:'Browser profile "disconnected-profile" is not connected'}
        : {status:'captured',url_check:{valid_content:true}};
    }, {out:directory,profile:'silent-profile'}, {status:'failed',stop_reason:'unavailable',browser:{context_id:'silent-profile'}}, {pickProfile:async exclude=>{assert.equal(exclude,'silent-profile');return 'connected-profile';}});
    assert.deepEqual(calls, ['disconnected-profile','connected-profile']);
    assert.equal(result.status, 'captured');
    assert.equal(result.visible_fallback.profile_selection, 'reselected_disconnected_profile');
  } finally {
    if(priorState===undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE=priorState;
    if(priorHeadless===undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE=priorHeadless;
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('incomplete profile reads retry in the explicitly selected foreground profile and skip an already-visible handoff', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-profile-fallback-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  const previousProfile = process.env.LUZ_HEADLESS_PROFILE;
  delete process.env.LUZ_HEADLESS_PROFILE;
  process.env.LUZ_CRAWL_STATE = directory;
  try {
    await rememberPreferences({ profile: 'saved-edge-profile' });
    const calls = [];
    const partial = { status: 'partial', stop_reason: 'scroll_budget', browser: { context_id: 'saved-context', closed: true } };
    const result = await retryVisibleIfIncomplete(async options => { calls.push(options); return { status: 'captured', url_check: { valid_content: true } }; }, { profile: 'selected-edge-profile', window: 'background', url: 'https://mp.weixin.qq.com/s/example' }, partial);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, 'selected-edge-profile');
    assert.equal(calls[0].window, 'background');
    assert.equal(result.visible_fallback.trigger, 'visible_scroll_budget');
    assert.equal(result.headless_fallback, undefined);

    const alreadyVisible = { status: 'awaiting_user', awaiting_reason: 'login_required', browser: { retained: true, parked: false, closed: false } };
    assert.strictEqual(await retryVisibleIfIncomplete(() => { throw new Error('must not retry'); }, {}, alreadyVisible), alreadyVisible);
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    if (previousProfile === undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE = previousProfile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an incomplete foreground retry persists fallback metadata with its continuation task', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-fallback-task-record-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  const previousProfile = process.env.LUZ_HEADLESS_PROFILE;
  const previousLaunch = process.env.LUZ_NO_BROWSER_LAUNCH;
  process.env.LUZ_CRAWL_STATE = directory;
  process.env.LUZ_HEADLESS_PROFILE = 'headless-profile';
  // Never let the visible retry open a real Edge window.
  process.env.LUZ_NO_BROWSER_LAUNCH = '1';
  try {
    await rememberPreferences({ profile: 'saved-edge-profile' });
    const out = path.join(directory, 'output');
    const taskId = 'visible-partial-task';
    const taskFile = path.join(out, 'raw/tasks', `${taskId}.json`);
    await fs.mkdir(path.dirname(taskFile), { recursive: true });
    await fs.writeFile(taskFile, JSON.stringify({ id: taskId, result: { status: 'awaiting_user', content_status: 'partial', awaiting_reason: 'content_incomplete' } }));
    const result = await retryVisibleIfIncomplete(
      async () => ({ status: 'awaiting_user', task_id: taskId, content_status: 'partial', awaiting_reason: 'content_incomplete' }),
      { out, url: 'https://mp.weixin.qq.com/s/example' },
      { status: 'partial', stop_reason: 'scroll_budget', browser: { context_id: 'headless-profile' } },
    );
    const saved = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    assert.deepEqual(saved.result.visible_fallback, result.visible_fallback);
    assert.deepEqual(saved.result.headless_fallback, result.headless_fallback);
    assert.equal(saved.result.awaiting_reason, 'content_incomplete');
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    if (previousProfile === undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE = previousProfile;
    if (previousLaunch === undefined) delete process.env.LUZ_NO_BROWSER_LAUNCH; else process.env.LUZ_NO_BROWSER_LAUNCH = previousLaunch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('headless startup failures use the visible profile, but errors after the operation starts are not retried', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-headless-start-fallback-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = directory;
  try {
    await rememberPreferences({ profile: 'saved-edge-profile' });
    const calls = [];
    const result = await withVisibleFallbackOnHeadlessStartFailure(
      { headless: true, window: 'background', url: 'https://www.xiaohongshu.com/explore/example' },
      async options => { calls.push(options); return { status: 'captured', url_check: { valid_content: true } }; },
      async () => { throw new Error('headless Edge failed to start'); },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, 'saved-edge-profile');
    assert.equal(calls[0].window, 'background');
    assert.equal(calls[0]._luz_visible_fallback, true);
    assert.equal(result.status, 'captured');
    assert.equal(result.headless_fallback.trigger, 'headless_unavailable');

    let startedCalls = 0;
    await assert.rejects(withVisibleFallbackOnHeadlessStartFailure(
      {},
      async () => { startedCalls++; return { status: 'failed' }; },
      async operation => { await operation('headless-profile'); throw new Error('headless shutdown failed'); },
    ), /headless shutdown failed/);
    assert.equal(startedCalls, 1);
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('semantic X articles retain exact body, exclude avatars, and do not borrow a quoted source ID', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    const article = `<article><a href="/author"><div class="x-avatar"><img src="https://pbs.twimg.com/profile_images/avatar.jpg"></div></a><a href="/author">Display Name</a><div class="text-lead" dir="auto">An introduction</div><div><h1 data-article-part="title">Article title</h1><div data-article-part="body"><p>Exact first paragraph.</p><p>Exact second paragraph.</p><a href="https://x.com/other/status/999">Quoted post</a><img src="https://pbs.twimg.com/media/example.jpg"></div></div><a href="/author/status/123">2026-10-25</a><a href="/author/status/123">1,234 views</a><div data-engagement-action="like">42</div><div data-engagement-action="reply">3</div></article>`;
    await page.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>${article}</main>` }));
    await page.goto('https://x.com/author/status/123');
    const value = await page.evaluate(extractPage, { platform: 'x', requestedURL: 'https://x.com/author/status/123', comments: true, includePresentation: false });
    assert.equal(value.target_present, true);
    assert.equal(value.post.account.handle, 'author');
    assert.equal(value.post.account.name, 'Display Name');
    assert.equal(value.post.engagement.likes.value, 42);
    assert.equal(value.post.engagement.views.value, 1234);
    assert(value.post.text.includes('Exact first paragraph.\n\nExact second paragraph.'));
    assert.deepEqual(value.post.images.map(x => x.url), ['https://pbs.twimg.com/media/example.jpg']);
    const wrong = await page.evaluate(extractPage, { platform: 'x', requestedURL: 'https://x.com/other/status/999', includePresentation: false });
    assert.equal(wrong.target_present, false);
    await page.setContent('<main><article data-testid="tweet"><div data-testid="User-Name"><div>Display Name</div><div>@author</div></div><a href="/author/status/123"><time datetime="2026-10-25">Today</time></a><div data-testid="tweetText">Original introduction</div></article><div data-testid="twitterArticleReadView"><div data-testid="twitterArticleRichTextView">Original article body<a href="/i/article/456/media/111">First image</a><a href="/i/article/456/media/222">Second image</a></div></div></main>');
    const classic = await page.evaluate(extractPage, { platform: 'x', requestedURL: 'https://x.com/author/status/123', includePresentation: false, articleMedia: {222:{url:'https://pbs.twimg.com/media/second.jpg'},111:{url:'https://pbs.twimg.com/media/first.jpg'}} });
    assert.equal(classic.target_present, true); assert.equal(classic.post.account.handle, 'author'); assert.equal(classic.post.account.name, 'Display Name'); assert(classic.post.text.startsWith('Original article body'));
    assert.deepEqual(classic.post.images.map(x=>x.url), ['https://pbs.twimg.com/media/first.jpg','https://pbs.twimg.com/media/second.jpg']);
    await page.evaluate(() => { const image=document.createElement('img');image.src='https://pbs.twimg.com/media/first?format=jpg&name=small';document.querySelector('[data-testid="twitterArticleRichTextView"]').prepend(image); });
    const variants = await page.evaluate(extractPage, { platform: 'x', requestedURL: 'https://x.com/author/status/123', includePresentation: false, articleMedia: {222:{url:'https://pbs.twimg.com/media/second.jpg'},111:{url:'https://pbs.twimg.com/media/first.jpg'}} });
    assert.deepEqual(variants.post.images.map(x=>x.url), ['https://pbs.twimg.com/media/first?format=jpg&name=small','https://pbs.twimg.com/media/second.jpg']);
    await page.setContent('<main>访问 x.com 的请求遭到拒绝 HTTP ERROR 403</main>');
    const blocked = await page.evaluate(extractPage, { platform: 'x', requestedURL: 'https://x.com/search?q=test', isSearch: true, includePresentation: false });
    assert.equal(blocked.gate, 'access_denied'); assert.equal(blocked.target_present, false);
    await page.setContent('<main></main>');
    const shell = await page.evaluate(extractPage, { platform:'x', requestedURL:'https://x.com/search?q=test', includePresentation:false });
    assert.equal(shell.target_present, false);
    await page.goto('https://x.com/i/jf/onboarding/web?mode=login');
    await page.setContent('');
    const login = await page.evaluate(extractPage, { platform:'x', requestedURL:'https://x.com/search?q=test', includePresentation:false });
    assert.equal(login.gate, 'login_required'); assert.equal(login.target_present, false);
    await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main><h1>Prompt library</h1><p>Original prompt without social engagement controls.</p></main>' }));
    await page.goto('https://example.com/library');
    const generic = await page.evaluate(extractPage, { platform:'web', requestedURL:'https://example.com/library', includePresentation:false });
    assert.equal(generic.target_present, true);
    assert(generic.post.text.includes('Original prompt'));
    assert(Object.values(generic.post.engagement).every(metric => metric.value === null));
  } finally { await browser.close(); }
});

test('hidden containers cannot become body text, and visible verification prompts stop writes', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    const options = { platform:'web', requestedURL:'https://example.com/', includePresentation:false };
    await page.setContent('<body>Before navigation</body>');
    await page.evaluate(() => document.documentElement.remove());
    const navigating = await page.evaluate(extractPage, options);
    assert.equal(navigating.target_present, false);
    assert.equal(navigating.loading, true);
    await page.setContent('<body><main hidden><style>.ExperienceHero-enter{color:red}</style>Hidden content</main></body>');
    const hidden = await page.evaluate(extractPage, options);
    assert.equal(hidden.post?.text || '', ''); assert.equal(hidden.target_present, false);
    await page.setContent('<main hidden>Hidden content</main><main style="display:contents"><style>.unused{color:red}</style><p>Visible original text</p></main>');
    const contents = await page.evaluate(extractPage, options);
    assert.equal(contents.post.text, 'Visible original text');
    await page.setContent('<article><p>为保证您的正常访问,请进行如下验证</p></article><div hidden>为保证您的正常访问,请进行如下验证</div><button>Search</button>');
    assert.equal((await page.evaluate(domOperation, { action:'read' })).gate, null);
    assert.equal((await page.evaluate(extractPage, options)).gate, null);
    await page.setContent('<main><h2>访问验证</h2><p>为保证您的正常访问,请进行如下验证</p><button>Search</button></main>');
    assert.equal((await page.evaluate(domOperation, { action:'read' })).gate, 'verification_required');
    assert.equal((await page.evaluate(extractPage, options)).gate, 'verification_required');
    const write = await page.evaluate(domOperation, { action:'click', selector:'button' });
    assert.equal(write.ok, false); assert.equal(write.error.code, 'verification_required');
    await page.setContent('<main><h2>百度安全验证</h2><p>请完成下方验证后继续操作</p><p>图片由AI生成</p><p>拖动左侧滑块使图片为正</p></main>');
    assert.equal((await page.evaluate(extractPage, options)).gate, 'verification_required');
    await page.setContent('<title>请稍候…</title><main><h1>www.libhunt.com</h1><p>正在进行安全验证</p><p>本网站使用安全服务防护恶意自动程序。在验证您不是自动程序期间，将显示此页面。</p><button>Search</button></main>');
    assert.equal((await page.evaluate(extractPage, options)).gate, 'verification_required');
    assert.equal((await page.evaluate(domOperation, {action:'click',selector:'button'})).error.code, 'verification_required');
  } finally { await browser.close(); }
});

test('project search submits the real input and never clicks unrelated topic or project actions', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<header><input placeholder="Search..."><button onclick="window.wrong=true">提交项目</button></header><main><input id="repo" placeholder="请输入搜索关键字或 repo url"><button onclick="window.wrong=true">Go</button></main><script>window.committed="";document.querySelector("#repo").oninput=e=>setTimeout(()=>{window.committed=e.target.value;},0);document.querySelector("#repo").onkeydown=e=>{if(e.key==="Enter")window.actualQuery=window.committed;};</script>');
    const result = await page.evaluate(submitSearch, {query:'browser automation',mode:'form'});
    assert.equal(result.method, 'enter_key');
    assert.equal(await page.evaluate(() => window.actualQuery), 'browser automation');
    assert.equal(await page.evaluate(() => Boolean(window.wrong)), false);
    await page.setContent('<script id="__NEXT_DATA__" type="application/json">{}</script><main><input id="late" placeholder="请输入搜索关键字或 repo url"></main><script>setTimeout(()=>{document.querySelector("#late").onkeydown=e=>{if(e.key==="Enter")window.actualQuery=e.target.value;};},400);</script>');
    await page.evaluate(submitSearch, {query:'hydrated query',mode:'form'});
    assert.equal(await page.evaluate(() => window.actualQuery), 'hydrated query');
    await page.setContent('<header><input id="query" placeholder="搜索开源项目"><a class="submit" onclick="window.wrong=true">提交项目</a></header><script>document.querySelector("#query").onkeydown=e=>{if(e.key==="Enter")window.actualQuery=e.target.value;};</script>');
    await page.evaluate(submitSearch, {query:'浏览器',mode:'form'});
    assert.equal(await page.evaluate(() => window.actualQuery), '浏览器');
    assert.equal(await page.evaluate(() => Boolean(window.wrong)), false);
    await page.setContent('<header><a href="https://github.com/example/noise">Popular project</a></header><main><article><a href="https://github.com/example/browser">Browser automation</a><p>Relevant browser automation project</p></article><article><a href="https://github.com/example/unrelated">Unrelated app</a><p>Unrelated utility project</p></article></main>');
    const snapshot = await page.evaluate(extractPage, {platform:'github',requestedURL:'https://github.com/search',isSearch:true,includePresentation:false});
    assert.equal(snapshot.links.find(item=>item.url.endsWith('/noise'))?.context || '', '');
    assert(!snapshot.links.find(item=>item.url.endsWith('/unrelated')).context.includes('browser automation'));
    await page.setContent('<main><article><a href="https://hellogithub.com/repository/lightpanda-io/browser"><header>推荐：启动速度极快的无头浏览器</header><p>这是一款支持自动化的开源浏览器项目</p></a></article></main><aside class="recommended"><a href="https://hellogithub.com/repository/example/noise">推荐项目 浏览器</a></aside>');
    const wrapped = await page.evaluate(extractPage, {platform:'web',requestedURL:'https://hellogithub.com/search/result?q=浏览器',isSearch:true,includePresentation:false});
    assert(wrapped.links.find(item=>item.url.endsWith('/browser')).context.includes('开源浏览器项目'));
    assert.equal(wrapped.links.find(item=>item.url.endsWith('/noise')).search_chrome, true);
  } finally { await browser.close(); }
});

test('synchronous search popups stay in the owned page and cannot execute non-HTTP URLs', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-popup-'));
  try {
    const page = await browser.newPage();
    await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Search results</main>' }));
    await page.goto('https://example.com/');
    await page.setContent('<button id="search" onclick="window.open(\'/results?q=doors\',\'_blank\',\'noopener,noreferrer\')">Search</button>');
    const operations = new BrowserOperations(page, testPolicy(directory), (await page.url()));
    const result = await operations.dom({ action: 'click', selector: '#search' });
    assert.equal(result.navigation_url, 'https://example.com/results?q=doors');
    assert.equal((await page.url()), result.navigation_url); assert.equal((await browser.pageCount()), 1);
    assert.equal(result.result.effect_verified, false);
    await page.setContent('<button id="search" onclick="window.open(\'javascript:window.exposed=true\')">Search</button>');
    await assert.rejects(operations.dom({ action: 'click', selector: '#search' }), /HTTP/);
    assert.equal(await page.evaluate(() => Boolean(window.exposed)), false);
    await page.setContent('<button id="search" onclick="window.open(\'/a\');window.open(\'/b\')">Search</button>');
    const ambiguous = await page.evaluate(domOperation, { action: 'click', selector: '#search' });
    assert.equal(ambiguous.error.code, 'invalid_target');
    assert.equal((await browser.pageCount()), 1);
    assert.equal(await page.evaluate(() => /\[native code\]/.test(window.open.toString())), true);
  } finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('TikTok portals without a video payload remain readable', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<main><h1>Creative Center</h1><p>Top Ads and trends</p></main>');
    const portal = await page.evaluate(extractPage, { platform:'tiktok', requestedURL:'https://ads.tiktok.com/business/creativecenter/', includePresentation:false });
    assert(portal.post.text.includes('Top Ads and trends'));
    const missing = await page.evaluate(extractPage, { platform:'tiktok', requestedURL:'https://www.tiktok.com/@author/video/123', includePresentation:false });
    assert.equal(missing.target_present, false);
  } finally { await browser.close(); }
});

test('an interrupted headless operation closes only its dedicated browser', { skip: process.env.LUZ_HEADLESS_INTEGRATION !== '1' || !edgeAvailable }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-headless-'));
  const previous = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = directory;
  let browser;
  try {
    await assert.rejects(withHeadlessSession(async (profile, edge) => {
      assert(profile); browser = edge;
      throw new Error('intentional operation interruption');
    }), /intentional operation interruption/);
    assert.equal(await Promise.race([browser.exited.then(() => 'exited'), new Promise((resolve) => setTimeout(resolve, 5000, 'running'))]), 'exited');
  } finally { if (previous === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previous; await fs.rm(directory, { recursive: true, force: true }); }
});

test('without a visible browser the silent result is kept and nothing is sent to another session', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-no-visible-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  const previousProfile = process.env.LUZ_HEADLESS_PROFILE;
  const previousLaunch = process.env.LUZ_NO_BROWSER_LAUNCH;
  process.env.LUZ_CRAWL_STATE = directory;
  process.env.LUZ_HEADLESS_PROFILE = 'headless-profile';
  process.env.LUZ_NO_BROWSER_LAUNCH = '1';
  try {
    let called = false;
    const initial = { status: 'partial', stop_reason: 'scroll_budget', browser: { context_id: 'headless-profile' } };
    const result = await retryVisibleIfIncomplete(async () => { called = true; return { status: 'captured' }; }, { out: path.join(directory, 'output'), url: 'https://example.com/' }, initial, { pickProfile: async () => undefined });
    assert.equal(called, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.visible_fallback.visible_status, 'skipped');
  } finally {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    if (previousProfile === undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE = previousProfile;
    if (previousLaunch === undefined) delete process.env.LUZ_NO_BROWSER_LAUNCH; else process.env.LUZ_NO_BROWSER_LAUNCH = previousLaunch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
