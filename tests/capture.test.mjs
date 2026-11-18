import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { canonicalURL, platformOf, searchURL, validateURL, extractURLs, CATALOG } from '../lib/platforms.mjs';
import { capture } from '../lib/capture.mjs';
import { createTaskArchive, verifyArchive, hash, mergeItems, recordExperience, findExperience, matchesQuery, safeTitle } from '../lib/archive.mjs';
import { htmlDocument } from '../lib/html.mjs';
import { articleMediaFromNetwork } from '../lib/extract-page.mjs';
import { search, sourceCandidates } from '../lib/search.mjs';
import { testPolicy } from './helpers.mjs';
import { OperationError } from '../lib/failure.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-test-'));
process.env.LUZ_CRAWL_STATE = path.join(tmp, 'state');
test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

function snapshot(overrides = {}) {
  const body = 'This is the real page body, with enough content to distinguish it from an empty loading placeholder. '.repeat(3);
  return { url: 'https://x.com/a/status/123', title: 'Test source', text: body, html: `<article>${body}</article>`, presentation: { html: `<article>${body}</article>`, text_chars: body.length, assets: [], width: 598 }, items: [{ id: '123', url: 'https://x.com/a/status/123', author: 'a', kind: 'target_post', text: body }], media: [], links: [], transcript: [], article_links: [], target_present: true, gate: null, scroll: { at_bottom: true, height: 1500 }, ...overrides };
}
function githubRepositorySnapshot(overrides = {}) {
  const body = 'Customer Service\nAbout\n\nPractice app with Typescript. This README contains the repository setup and usage details. '.repeat(8);
  return {
    url: 'https://github.com/example/customer-service',
    title: 'GitHub - example/customer-service: Customer Service · GitHub',
    text: body,
    html: `<main><article class="markdown-body"><h1>Customer Service</h1><p>${body}</p></article></main>`,
    presentation: { html: `<article class="markdown-body"><p>${body}</p></article>`, text_chars: body.length, assets: [], width: 980 },
    items: [{ id: 'github:example/customer-service', url: 'https://github.com/example/customer-service', kind: 'page_body', text: body }],
    media: [], links: [], transcript: [], article_links: [], comments: [], post: null,
    target_present: true, gate: null, loading: true,
    github_repository_ready: true,
    scroll: { at_bottom: false, height: 2427, top: 0, viewport: 628 },
    ...overrides,
  };
}
function page(snapshots) {
  let index = 0;
  return { opened: [], goto: async function (url) { this.opened.push(url); }, evaluate: async (code) => {
    if (code === 'location.href') return snapshots[0].url;
    if (code === '({url:location.href,ready:Boolean(document.body)})') return {url:snapshots[0].url,ready:true};
    if (code.includes('function extractPage')) return snapshots[Math.min(index++, snapshots.length - 1)];
    if (code.includes('function expandPage')) return [];
    if (code.includes('function scrollPage')) return { at_bottom: true, height: 1500, top: 500, viewport: 1000 };
    if (code.includes('function dismissLoginGate')) return [];
    if (code.includes('element.scrollTo(0, element.scrollHeight)')) return true;
    throw new Error('Unexpected browser operation');
  } };
}
const opts = (out, more = {}) => ({ url: 'https://x.com/a/status/123', out: path.join(tmp, out), executionPolicy: testPolicy(tmp), delay: 0, scrolls: 5, screenshot: false, ...more });

test('large DOM snapshots round-trip losslessly and remain verifiable on resume', async () => {
  const body = 'Sample browser snapshot text. '.repeat(45000);
  const observed = snapshot({ text: body, html: '<article>' + body + '</article>' });
  const options = opts('large-snapshots', { scrolls: 0 });
  const first = await capture(page([observed]), options);
  const saved = JSON.parse(await fs.readFile(path.join(first.folder, 'content.json'), 'utf8'));
  const stored = saved.snapshots[0].path;
  assert.match(stored, /\.json\.gz$/);
  assert.equal(JSON.parse(gunzipSync(await fs.readFile(path.join(first.folder, stored)))).text, body);
  assert.equal(gunzipSync(await fs.readFile(path.join(first.folder, stored.replace('.json.gz', '.html.gz')))).toString(), observed.html);
  assert.ok((await fs.stat(path.join(first.folder, stored))).size < Buffer.byteLength(body));
  await assert.rejects(fs.access(path.join(first.folder, stored.replace('.gz', ''))), { code: 'ENOENT' });
  const resumed = await capture(page([snapshot()]), { ...options, resume: true });
  assert.equal(resumed.folder, first.folder);
  assert.ok((await verifyArchive(resumed.folder)).ok);
});

test('repository form searches verify the landed query before claiming submission took effect', async () => {
  for (const success of [false, true]) {
    const landed = success ? 'https://gitcn.org/search/result?q=browser%20automation' : 'https://gitcn.org/search';
    const original = page([snapshot({url:landed})]);
    const evaluate = original.evaluate;
    original.evaluate = async code => code.includes('function submitSearch') ? { submitted:true, method:'enter_key', query:'browser automation' } : evaluate(code);
    const result = await capture(original, opts(`form-query-${success}`, {url:'https://gitcn.org/search',query:'browser automation',search_form:{mode:'form',entry_url:'https://gitcn.org/search',query_parameter:'q'}}));
    assert.equal(result.search_action.effect_verified, success);
  }
});

test('a search navigation verifies an unknown dispatch outcome without submitting twice', async () => {
  const landed = 'https://gitcn.org/search/result?q=browser%20automation';
  const original = page([snapshot({url:landed})]);
  const evaluate = original.evaluate;
  let submissions = 0;
  original.evaluate = async code => {
    if (code.includes('function submitSearch')) { submissions++; throw new OperationError('write_outcome_unknown', 'Navigation replaced the search execution context'); }
    return evaluate(code);
  };
  const result = await capture(original, opts('form-unknown-navigation', {url:'https://gitcn.org/search',query:'browser automation',search_form:{mode:'form',entry_url:'https://gitcn.org/search',query_parameter:'q'}}));
  assert.equal(submissions, 1);
  assert.equal(result.status, 'captured');
  assert.equal(result.search_action.effect_verified, true);
  assert.equal(result.search_action.submitted, true);
  assert.equal(result.search_action.dispatch_outcome_unknown, true);
});

test('URL validation, aliases and ID deduplication', () => {
  for (const url of ['file:///secret', 'javascript:alert(1)', 'https://user:password@example.com']) assert.throws(() => validateURL(url));
  assert.equal(platformOf('https://x.com.evil.test/'), 'web');
  assert.equal(canonicalURL('https://twitter.com/a/status/123?s=20'), canonicalURL('https://x.com/b/status/123'));
  assert.equal(canonicalURL('https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=x'), 'https://www.xiaohongshu.com/explore/abc123');
  assert.equal(canonicalURL('https://www.xiaohongshu.com/search_result/abc123?xsec_token=x'), 'https://www.xiaohongshu.com/explore/abc123');
  assert.equal(canonicalURL('https://youtu.be/abc?si=1'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(extractURLs('[a](https://x.com/a/status/1) — https://twitter.com/b/status/1?x=1\nhttps://x.com/a/status/2').length, 2);
  for (const platform of ['x', 'xhs', 'wechat', 'douyin', 'youtube', 'reddit', 'zhihu', 'douban', 'bilibili', 'web']) assert.ok(searchURL(platform, '中文 & plus').startsWith('https://'));
});

test('Bilibili search excludes creator upload screens and accepts real detail IDs', () => {
  const content = {requested_url:'https://search.bilibili.com/all?keyword=Python',links:[{url:'https://member.bilibili.com/platform/upload/video/frame'},{url:'https://www.bilibili.com/video/BV1Ab4y1x7Cd/'},{url:'https://www.bilibili.com/video/not-a-video'}]};
  assert.deepEqual(sourceCandidates(content,CATALOG.find(site=>site.id==='bilibili')).map(item=>item.url),['https://www.bilibili.com/video/BV1Ab4y1x7Cd/']);
});

test('search candidates use the result-row context when a search engine link has no own text', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const content = {
    requested_url: 'https://www.bing.com/search?q=site%3Apep.com.cn+%E8%8B%B1%E8%AF%AD',
    links: [{
      url: 'https://www.pep.com.cn/zslth/yyptzy/',
      text: '',
      context: '人教网\n义务教育教科书英语教材数字配套资源\n三年级下册\n课文音频'
    }]
  };
  const found = sourceCandidates(content, site, true, 'site:pep.com.cn 英语 数字教材 配套 音频 人教版');
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'https://www.pep.com.cn/zslth/yyptzy/');
  assert.match(found[0].text, /数字配套资源/);
});

test('explicit site scopes reject search-engine results from other domains', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const content = {
    requested_url: 'https://www.bing.com/search?q=site%3Apep.com.cn+%E8%8B%B1%E8%AF%AD',
    links: [
      { url: 'https://www.pep.com.cn/zslth/yyptzy/', text: '人教版英语数字教材官方资源' },
      { url: 'https://example.com/english-resources', text: '人教版英语数字教材官方资源' }
    ]
  };
  const found = sourceCandidates(content, site, true, 'site:pep.com.cn 英语 数字教材');
  assert.deepEqual(found.map(item => item.url), ['https://www.pep.com.cn/zslth/yyptzy/']);
});

test('the search engine vendor help pages in an answer card never become result candidates', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const answerCard = '喜欢\n不喜欢\nB2B订货系统功能模块 业务流程\nB2B订货系统的核心功能模块包括订单管理、商品展示、渠道定价与资金核销。';
  const content = {
    requested_url: 'https://www.bing.com/search?q=B2B%E8%AE%A2%E8%B4%A7%E7%B3%BB%E7%BB%9F+%E5%8A%9F%E8%83%BD+%E6%A8%A1%E5%9D%97',
    links: [
      { url: 'https://support.microsoft.com/zh-cn/bing/how-bing-delivers-search-results', text: '了解必应如何提供搜索结果', context: answerCard },
      { url: 'https://go.microsoft.com/fwlink/?linkid=2259814', text: 'B2B订货系统功能模块', context: answerCard },
      { url: 'https://zhuanlan.zhihu.com/p/1234567890', text: 'B2B订货平台与经销商平台的功能模块', context: answerCard },
    ]
  };
  assert.deepEqual(sourceCandidates(content, site, true, 'B2B订货系统 功能 模块').map(item => item.url), ['https://zhuanlan.zhihu.com/p/1234567890']);
  // A query that names the vendor host keeps its pages.
  const scoped = sourceCandidates({ ...content, links: [content.links[0]] }, site, true, 'site:support.microsoft.com 必应 搜索结果');
  assert.equal(scoped.length, 1);
});

test('search result cards remain candidates when the snippet uses nearby vocabulary', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const content = {
    requested_url: 'https://www.bing.com/search?q=%E4%BA%BA%E6%95%99%E7%89%88',
    links: [{
      url: 'https://www.pep.com.cn/zslth/yyptzy/',
      text: '阅读更多',
      context: '人教网\n义务教育教科书英语教材数字配套资源\n三年级下册\n课文音频'
    }]
  };
  const found = sourceCandidates(content, site, true, '人教版 小学英语 数字教材 音频 官方');
  assert.equal(found.length, 1);
});

test('search result cards survive Chinese phrase variants without exact query words', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const content = {
    requested_url: 'https://www.bing.com/search?q=%E4%BA%BA%E6%95%99%E7%89%88',
    links: [{
      url: 'https://www.pep.com.cn/zslth/yyptzy/',
      text: '阅读更多',
      context: '人教网\n义务教育教科书英语教材数字配套资源\n三年级下册\n04 Read, circle and match. Then listen and check.'
    }]
  };
  const found = sourceCandidates(content, site, true, '人教版 小学英语 数字教材 音频 官方');
  assert.equal(found.length, 1);
  assert.match(found[0].text, /数字配套资源/);
  assert.ok(found[0].search_evidence.soft_terms.length >= 2);
});

test('search cards reject an explicitly conflicting school level in the link label', () => {
  const site = CATALOG.find(item => item.id === 'bing');
  const context = '人教网\n义务教育教科书英语教材数字配套资源';
  const found = sourceCandidates({ requested_url: 'https://www.bing.com/search?q=%E5%B0%8F%E5%AD%A6%E8%8B%B1%E8%AF%AD', links: [
    { url: 'https://www.pep.com.cn/zslth/yyptzy/czyy/7s/', text: '七年级上册 - 义务教育教科书英语教材数字配套资源', context },
    { url: 'https://www.pep.com.cn/zslth/yyptzy/xypep/3s/', text: '三年级上册 - 义务教育教科书英语教材数字配套资源', context }
  ] }, site, true, '小学英语 数字教材');
  assert.deepEqual(found.map(item => item.url), ['https://www.pep.com.cn/zslth/yyptzy/xypep/3s/']);
});

test('a long query does not accept a result that matches only a generic trailing word', () => {
  const site = CATALOG.find(item => item.id === 'sogou');
  const found = sourceCandidates({ requested_url: 'https://www.sogou.com/web?query=test', links: [
    { url: 'https://so.html5.qq.com/landingpage/page/redirect-page-pc?query=ad', text: '阿里巴巴工厂直供特惠', context: '热点新闻\n官方介绍五中全会最重要成果\n热' },
    { url: 'https://mp.weixin.qq.com/s/example', text: '人教版小学英语音频', context: '人教版小学英语(电子课本+音频mp3)' }
  ] }, site, true, '人教版 小学英语 数字教材 音频 官方');
  assert.deepEqual(found.map(item => item.url), ['https://mp.weixin.qq.com/s/example']);
});

test('virtualized tweets survive scrolls; longer expansion wins', async () => {
  const second = { id: '456', url: 'https://x.com/a/status/456', author: 'a', kind: 'thread_or_reply', text: 'Second thread entry' };
  const first = snapshot();
  const browser = page([first, first, snapshot({ items: [second] })]);
  const result = await capture(browser, opts('virtual'));
  assert.equal(result.status, 'captured', result.error || result.limitations?.join(', '));
  assert.equal(result.completeness.items, 2);
  assert.equal(browser.opened.length, 1);
  assert.equal((await verifyArchive(result.folder)).ok, true);
  assert.equal(path.dirname(result.html_file), result.folder);
  assert.ok((JSON.parse(await fs.readFile(path.join(result.folder, 'manifest.json'), 'utf8'))).files.some((entry) => entry.path === path.basename(result.html_file)));
  assert.equal(mergeItems([{ id: '1', text: 'short' }], [{ id: '1', text: 'a longer expanded paragraph' }])[0].text, 'a longer expanded paragraph');
});

test('login shell cannot become success, even with lots of UI text', async () => {
  const result = await capture(page([snapshot({ gate: 'login_required', items: [], target_present: false })]), opts('login'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.stop_reason, 'login_required');
  assert.equal(result.completeness.target_present, false);
  assert.equal((await verifyArchive(result.folder)).ok, true);
});

test('error-page recommendation links are rejected before trying a public search route', async () => {
  let url;
  const browser = {
    opened: [],
    goto: async (value) => { url = value; browser.opened.push(value); },
    evaluate: async (code) => {
      if (code === 'location.href') return url;
      if (code.includes('function expandPage')) return [];
      if (code.includes('function scrollPage') && !code.includes('function extractPage')) return { at_bottom: true, height: 1500, top: 500, viewport: 1000 };
      if (code.includes('function extractPage')) {
        const failed = !url.includes('bing.com');
        return snapshot({ url, title: failed ? '404页面' : 'Actual search results', gate: failed ? 'unavailable' : null, links: [{ url: 'https://www.xiaohongshu.com/explore/abc123' }] });
      }
      throw new Error('Unexpected browser operation');
    },
  };
  const result = await search(browser, opts('search-error', { platform: 'xhs', query: '人工智能', read: 0, scrolls: 0 }));
  assert.equal(result.attempts[0].candidates, 0);
  assert.equal(result.route_kind, 'public_index');
  assert.equal(result.discovered_candidates, 1);
  assert.equal(browser.opened.length, 2);
});

test('scroll budget and absent target remain partial or blocked', async () => {
  const result = await capture(page([snapshot()]), opts('budget', { scrolls: 0 }));
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'scroll_budget');
  const missing = await capture(page([snapshot({ target_present: false, items: [] })]), opts('missing', { scrolls: 0 }));
  assert.equal(missing.status, 'blocked');
});

test('GitHub repository README is complete when a persistent shell loader never reaches the page bottom', async () => {
  const result = await capture(page([githubRepositorySnapshot()]), opts('github-repository-loader', {
    url: 'https://github.com/example/customer-service',
    scrolls: 8,
  }));
  assert.equal(result.status, 'captured');
  assert.equal(result.stop_reason, 'repository_dom_complete');
  assert.equal(result.url_check.valid_content, true);
  assert(result.completeness.chars > 500);
});

test('public search candidates cannot hide a native login gate when no source body was readable', async () => {
  let url;const opened=[];
  const browser={goto:async value=>{url=value;opened.push(value);},evaluate:async code=>{
    if(code==='location.href')return url;
    if(code.includes('function expandPage'))return[];
    if(code.includes('function scrollPage')&&!code.includes('function extractPage'))return{at_bottom:true,height:1500,top:500,viewport:1000};
    if(code.includes('function dismissLoginGate'))return[];
    if(code.includes('function extractPage')){
      const index=url.includes('bing.com'),native=url.includes('search_result');
      return snapshot({url,gate:index?null:native?'login_required':'unavailable',target_present:index,items:index?snapshot().items:[],links:index?[{url:'https://www.xiaohongshu.com/explore/auth-required'}]:[]});
    }
    throw new Error('Unexpected browser operation');
  }};
  const result=await search(browser,opts('search-login-fallback',{platform:'xhs',query:'人工智能',read:1,scrolls:0}));
  assert(opened[0].includes('xiaohongshu.com/search_result'));
  assert.equal(result.discovered_candidates,1);assert.equal(result.sources[0].url_check.valid_content,false);
  assert.equal(result.status,'awaiting_user');assert.equal(result.awaiting_reason,'login_required');assert.equal(result.requires_user,true);
  assert(result.handover_url.includes('xiaohongshu.com/search_result'));
});

test('loading replies cannot become stable completion and displayed counts survive collapsed controls', async () => {
  const post = { id: '123', text: 'body', images: [], videos: [], engagement: { comments: { value: 12, raw: '12 Replies', approximate: false } } };
  const first = snapshot({ post });
  const later = snapshot({ post: { ...post, engagement: { comments: { value: null, raw: 'Hide comments', approximate: false } } }, comments: [], loading: true });
  const result = await capture(page([first, later]), opts('loading-replies', { comments: true, scrolls: 4 }));
  assert.equal(result.status, 'partial'); assert.equal(result.stop_reason, 'scroll_budget');
  assert.equal(result.post.engagement.comments.value, 12);
  assert.ok(result.limitations.some((value) => value.includes('未加载评论')));
});

test('the same URL captured again is its own archive and the old one stays as it was', async () => {
  const options = opts('recapture');
  const first = await capture(page([snapshot()]), options);
  const frozen = async () => ({ manifest: hash(await fs.readFile(path.join(first.folder, 'manifest.json'))), html: hash(await fs.readFile(first.html_file)) });
  const before = await frozen();
  const again = await capture(page([snapshot({ title: '改过标题的第二次抓取' })]), options);
  assert.notEqual(again.folder, first.folder);
  assert.notEqual(again.html_file, first.html_file);
  assert.equal(path.basename(again.folder).slice(0, 4), '0002');
  assert.deepEqual(await frozen(), before, 'the first archive is not rewritten');
  assert.equal((await verifyArchive(first.folder)).ok, true);
  assert.equal((await verifyArchive(again.folder)).ok, true);
  const manifest = JSON.parse(await fs.readFile(path.join(again.folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.recapture_of, path.basename(first.folder));                    // the new archive says which one it follows
  const identity = JSON.parse(await fs.readFile(path.join(again.folder, 'identity.json'), 'utf8'));
  assert.equal(identity.recapture_of, path.basename(first.folder));
  const third = await capture(page([snapshot()]), options);
  assert.equal(path.basename(third.folder).slice(0, 4), '0003');
  assert.equal(JSON.parse(await fs.readFile(path.join(third.folder, 'manifest.json'), 'utf8')).recapture_of, path.basename(again.folder));
  assert.deepEqual(await frozen(), before);
  // --resume is the explicit way to continue: it picks the newest archive of that URL and leaves the older ones alone.
  const resumed = await capture(page([snapshot()]), { ...options, resume: true });
  assert.equal(path.basename(resumed.folder).slice(0, 4), '0003');
  assert.deepEqual(await frozen(), before);
});

test('resume verifies evidence, appends snapshots, never overwrites corrupted evidence', async () => {
  const options = opts('resume');
  const first = await capture(page([snapshot()]), options);
  const second = await capture(page([snapshot()]), { ...options, resume: true });
  assert.equal(second.folder, first.folder);
  assert.ok(second.completeness.snapshots > first.completeness.snapshots);
  assert.equal((await verifyArchive(second.folder)).ok, true);
  const manifest = path.join(second.folder, 'manifest.json');
  const before = hash(await fs.readFile(manifest));
  await fs.appendFile(second.html_file, '\nTampered');
  await assert.rejects(() => capture(page([snapshot()]), { ...options, resume: true }), /Cannot resume/);
  assert.equal(hash(await fs.readFile(manifest)), before);
  await assert.rejects(() => fs.access(path.join(second.folder, '.capture.lock')));
});

test('browser failure still leaves an honest verifiable failure archive', async () => {
  const browser = page([]); browser.goto = async () => { throw new Error('Browser Bridge disconnected'); };
  const result = await capture(browser, opts('failed'));
  assert.equal(result.status, 'failed');
  const manifest = JSON.parse(await fs.readFile(path.join(result.folder, 'manifest.json')));
  assert.equal(manifest.browser_opened, false);
  assert.equal((await verifyArchive(result.folder)).ok, true);
});

test('an occupied raw directory does not discard readable content or its titled HTML', async () => {
  const originalRename = fs.rename;
  try {
    fs.rename = async (from, to) => {
      if (String(from).endsWith('_未命名网页')) throw Object.assign(new Error('Directory is temporarily occupied'), { code: 'EPERM' });
      return originalRename(from, to);
    };
    const result = await capture(page([snapshot()]), opts('occupied-raw'));
    assert.equal(result.status, 'captured');
    assert.equal(path.basename(result.html_file), '0001_Test source.html');
    assert.equal((await verifyArchive(result.folder)).ok, true);
  } finally { fs.rename = originalRename; }
});

test('idempotent search experience is in the local memory store', async () => {
  const event = { platform: 'x', canonical_url: 'https://x.com/i/status/987', query: 'test demand', status: 'partial', stop_reason: 'scroll_budget' };
  const one = await recordExperience(event), two = await recordExperience(event);
  assert.equal(one, two);
  const records = await findExperience('test demand', 'x');
  assert.equal(records.events.length, 1);
  assert.equal(records.events[0].status, 'partial');
  assert.ok(records.route_hints.some((item) => item.platform === 'x'));
  assert.ok(records.route_hints.every((item) => ['x', 'web'].includes(item.platform)));
  assert.equal(matchesQuery('Next queries', 'x'), false);
  assert.equal(matchesQuery('X search: 赚钱案例', 'x 赚钱'), true);
});

test('resume cannot reuse old body as evidence for a current login or error page', async () => {
  const first = await capture(page([snapshot()]), opts('fresh-resume'));
  const current = await capture(page([snapshot({ gate: 'login_required', target_present: false, items: [], text: 'Login shell' })]), opts('fresh-resume', { resume: true }));
  assert.equal(current.status, 'blocked');
  assert.equal(current.completeness.chars, 0);
  assert.ok(current.completeness.snapshots > first.completeness.snapshots);
});

test('clicked browser result can be archived without navigating to a bare link', async () => {
  const browser = page([snapshot()]);
  const current = await capture(browser, opts('clicked', { current_page: true }));
  assert.equal(browser.opened.length, 0);
  assert.equal(current.status, 'captured');
  assert.equal(current.url_check.entry_method, 'clicked_search_result');
});

for (const taskLayout of [false, true]) test(`X article links preserve child verification (task layout: ${taskLayout})`, async () => {
  let currentURL;
  let reads = 0;
  const articleURL = 'https://x.com/i/article/789';
  const browser = { goto: async (url) => { currentURL = url; reads = 0; }, evaluate: async (code) => {
    if (code === 'location.href') return currentURL;
    if (code.includes('function expandPage')) return [];
    if (code.includes('function scrollPage') && !code.includes('function extractPage')) return { at_bottom: true, height: 1500, top: 500, viewport: 1000 };
    if (currentURL === articleURL) return snapshot({ url: articleURL, items: [{ id: 'article:789', kind: 'article', text: 'Article full text', url: articleURL }] });
    return snapshot({ article_links: reads++ < 2 ? [articleURL] : [] });
  } };
  const options = opts(taskLayout ? 'article-task' : 'article');
  if (taskLayout) options.out = await createTaskArchive(options.out, 'article task', {newTask: true});
  const result = await capture(browser, options);
  const content = JSON.parse(await fs.readFile(path.join(result.folder, 'content.json')));
  assert.equal(content.related.length, 1);
  assert.equal(content.related[0].status, 'captured');
  assert.equal((await verifyArchive(result.folder)).ok, true);
  const resumed = await capture(browser, {...options, resume: true});
  const resumedContent = JSON.parse(await fs.readFile(path.join(resumed.folder, 'content.json')));
  assert.equal(resumedContent.related.length, 1);
  assert.equal((await verifyArchive(resumed.folder)).ok, true);
  const child = JSON.parse(await fs.readFile(path.join(content.related[0].folder, 'content.json')));
  // Related pages stay inside the parent archive, each with its own HTML inside its own folder.
  assert.ok(content.related[0].folder.startsWith(result.folder + path.sep));
  assert.equal(path.dirname(content.related[0].html_file), content.related[0].folder);
  if (taskLayout) assert.equal(path.dirname(result.folder), path.join(options.out, 'raw'));
  await fs.appendFile(content.related[0].html_file, '\nModified child');
  assert.equal((await verifyArchive(result.folder)).ok, false);
});

test('redirected browser URL selects the actual platform extractor', async () => {
  const data = snapshot({ url: 'https://mp.weixin.qq.com/s/article', items: [{ id: 'article', text: 'Real article body', kind: 'page_body', url: 'https://mp.weixin.qq.com/s/article' }] });
  const result = await capture(page([data]), opts('redirect', { url: 'https://t.co/example' }));
  const content = JSON.parse(await fs.readFile(path.join(result.folder, 'content.json')));
  assert.equal(content.platform, 'wechat');
  assert.equal(content.resolved_url, data.url);
});

test('public-index search pages keep the requested platform result extractor after landing on Bing', async () => {
  const data = snapshot({ url: 'https://www.bing.com/search?q=site%3Agithub.com+playwright', items: [{ id: 'search', text: 'GitHub search results', kind: 'page_body', url: 'https://www.bing.com/search?q=site%3Agithub.com+playwright' }] });
  const browser = page([data]);
  const extractionPlatforms = [];
  const evaluate = browser.evaluate;
  browser.evaluate = async (code) => {
    if (code.includes('function extractPage')) extractionPlatforms.push(code.includes('"platform":"github"'));
    return evaluate(code);
  };
  const result = await capture(browser, opts('search-platform', {
    url: data.url,
    query: 'playwright',
    search_platform: 'github',
    scrolls: 0
  }));
  const content = JSON.parse(await fs.readFile(path.join(result.folder, 'content.json')));
  assert.equal(content.platform, 'bing');
  assert(extractionPlatforms.length > 0);
  assert(extractionPlatforms.every(Boolean));
});

test('resuming a renamed related page retains its snapshots and verifies current paths', async () => {
  const linkedURL = 'https://example.com/linked';
  let currentURL, linkedTitle = '旧关联标题';
  const browser = { goto: async url => { currentURL = url; }, evaluate: async code => {
    if (code === 'location.href') return currentURL;
    if (code.includes('function expandPage')) return [];
    if (code.includes('function scrollPage') && !code.includes('function extractPage')) return {at_bottom:true,height:1500,top:500,viewport:1000};
    return currentURL === linkedURL
      ? snapshot({url:linkedURL,title:linkedTitle,items:[{id:'linked',kind:'page_body',text:'Complete linked body',url:linkedURL}]})
      : snapshot({article_links:[linkedURL]});
  }};
  const options = opts('renamed-related');
  const first = await capture(browser, options);
  const oldChild = JSON.parse(await fs.readFile(path.join(first.folder, 'content.json'))).related[0];
  const oldManifest = JSON.parse(await fs.readFile(path.join(oldChild.folder, 'manifest.json')));
  linkedTitle = '新关联标题';
  const resumed = await capture(browser, {...options,resume:true});
  const currentChild = JSON.parse(await fs.readFile(path.join(resumed.folder, 'content.json'))).related[0];
  assert.match(currentChild.folder, /新关联标题$/);
  assert.equal((await verifyArchive(resumed.folder)).ok, true);
  for (const entry of oldManifest.files.filter(e => e.path.startsWith('snapshots/'))) {
    assert.equal(hash(await fs.readFile(path.join(currentChild.folder, entry.path))), entry.sha256);
  }
  await fs.appendFile(currentChild.html_file, '\nChanged current child');
  assert.equal((await verifyArchive(resumed.folder)).ok, false);
});

test('X Article body tied to the target permalink is substantive even when tweetText is empty', async () => {
  const data = snapshot({ title: 'Actual X Article title', items: [{ id: '123', kind: 'target_post', text: '', url: 'https://x.com/a/status/123' }, { id: 'article:123', kind: 'article', source_status_id: '123', text: 'Full article body', url: 'https://x.com/a/status/123' }] });
  const result = await capture(page([data]), opts('article-body'));
  assert.equal(result.status, 'captured');
  assert.equal(result.completeness.chars, 'Full article body'.length);
});

test('unchanged text above page bottom cannot stop lazy-loading capture early', async () => {
  const browser = page([snapshot()]);
  const evaluate = browser.evaluate;
  browser.evaluate = async (code) => {
    const value = await evaluate(code);
    if (code.includes('function extractPage')) value.scroll = { at_bottom: false, top: 200, viewport: 800, height: 20000 };
    return value;
  };
  const result = await capture(browser, opts('not-bottom'));
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'scroll_budget');
  assert.equal(result.completeness.snapshots, 6);
});

test('readable serial and source title replace URL hashes; resume keeps the serial', async () => {
  assert.equal(safeTitle('标题: 一 / 二? <三>\n'), '标题 一 二 三');
  assert.equal([...safeTitle('😀'.repeat(100))].length, 64);
  const names = opts('names');
  names.out = await createTaskArchive(names.out, 'names task', { newTask: true, threadId: null });
  const first = await capture(page([snapshot({ title: '第一篇：保留中文' })]), names);
  assert.equal(path.basename(first.html_file), '0001_第一篇：保留中文.html');
  assert.equal(path.dirname(first.html_file), first.folder);
  assert.equal(path.dirname(first.folder), path.join(names.out, 'raw'));
  const second = await capture(page([snapshot({ url: 'https://x.com/a/status/456', title: '第二篇', items: [{ id: '456', text: 'second' }] })]), { ...names, url: 'https://x.com/a/status/456' });
  assert.equal(path.basename(second.folder), '0002_第二篇');
  const resumed = await capture(page([snapshot({ title: '第一篇新标题' })]), { ...names, resume: true });
  assert.equal(path.basename(resumed.folder), '0001_第一篇新标题');
  assert.equal((await verifyArchive(resumed.folder)).ok, true);
  await assert.rejects(() => fs.access(first.html_file));
  assert.equal(path.basename(resumed.html_file), '0001_第一篇新标题.html');
  // The crawl summary keeps one row per source URL, so the resumed title replaces the first one.
  const summary = await fs.readFile(path.join(names.out, `${path.basename(names.out)}.html`), 'utf8');
  assert.ok(summary.includes('第一篇新标题'));
  assert.ok(summary.includes('第二篇'));
  assert.ok(!summary.includes('第一篇：保留中文'));
  await assert.rejects(() => fs.access(path.join(names.out, '参考链接.md')),{code:'ENOENT'});
  await assert.rejects(() => fs.access(path.join(resumed.folder, 'content.md')));
});

// Turns an archive written by the current layout into the older one: files under <archive>\raw\, the HTML in the delivery folder.
async function toOlderLayout(folder, deliveryRoot) {
  const manifestFile = path.join(folder, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const inner = path.join(folder, 'raw');
  await fs.mkdir(inner);
  for (const name of await fs.readdir(folder)) if (name !== 'raw' && name !== manifest.primary_file) await fs.rename(path.join(folder, name), path.join(inner, name));
  await fs.rename(path.join(folder, manifest.primary_file), path.join(deliveryRoot, manifest.primary_file));
  const html = manifest.files.find((entry) => entry.path === manifest.primary_file);
  Object.assign(manifest, { output_layout: 'html_and_raw_v1', delivery: { file: manifest.primary_file, bytes: html.bytes, sha256: html.sha256 }, related_deliveries: [], files: manifest.files.filter((entry) => entry !== html).map((entry) => ({ ...entry, path: `raw/${entry.path}` })) });
  await fs.writeFile(path.join(inner, 'manifest.json'), JSON.stringify(manifest));
}

test('resuming an archive of the older layout continues it in place with its serial, raw/ and delivery HTML', async () => {
  const options = opts('older-layout');
  const output = options.out;
  options.out = path.join(output, 'raw', '001_older task');
  await fs.mkdir(options.out, { recursive: true });
  await fs.writeFile(path.join(options.out, 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: 'older task' }));
  const first = await capture(page([snapshot()]), options);
  await toOlderLayout(first.folder, output);
  assert.equal((await verifyArchive(first.folder)).ok, true);
  const resumed = await capture(page([snapshot()]), { ...options, resume: true });
  assert.equal(resumed.folder, first.folder);
  assert.equal(resumed.html_file, path.join(output, path.basename(first.html_file)));
  assert.equal((await verifyArchive(resumed.folder)).ok, true);
  assert.ok(resumed.completeness.snapshots > first.completeness.snapshots);
  const manifest = JSON.parse(await fs.readFile(path.join(resumed.folder, 'raw', 'manifest.json'), 'utf8'));
  assert.equal(manifest.output_layout, 'html_and_raw_v1');
  assert.ok(manifest.files.every((entry) => entry.path.startsWith('raw/')));
  assert.deepEqual((await fs.readdir(resumed.folder)).sort(), ['raw']);
  // Corrupting the delivery HTML still refuses the next resume.
  await fs.appendFile(resumed.html_file, '\nTampered');
  await assert.rejects(() => capture(page([snapshot()]), { ...options, resume: true }), /Cannot resume/);
});

test('folders already numbered in the output make the next capture take the next number', async () => {
  const options = opts('number-collision');
  await fs.mkdir(path.join(options.out, '0001_留存'), { recursive: true });
  await fs.writeFile(path.join(options.out, '0001_留存', 'note.txt'), 'User-owned');
  const result = await capture(page([snapshot()]), options);
  assert.equal(result.status, 'captured');
  assert.equal(await fs.readFile(path.join(options.out, '0001_留存', 'note.txt'), 'utf8'), 'User-owned');
  assert.match(path.basename(result.folder), /^0002_/);
});

test('a verified complete X Article exports directly without scrolling through replies', async () => {
  const data = snapshot({ items: [{ id: 'article:123', source_status_id: '123', kind: 'article', text: 'Full article body' }], presentation: { kind: 'x_article', ready: true, media_pending: 0, text_chars: 17, html: '<article><h2>原小标题</h2><p>原段落</p><ol><li>原列表</li></ol></article>', assets: [], width: 598 } });
  const result = await capture(page([data]), opts('fast'));
  assert.equal(result.status, 'captured');
  assert.equal(result.stop_reason, 'article_dom_complete');
  assert.equal(result.completeness.scroll_rounds, 0);
  assert.equal(result.completeness.snapshots, 2);
  assert.match(await fs.readFile(result.html_file, 'utf8'), /<h2>原小标题<\/h2><p>原段落<\/p><ol><li>原列表/);
});

test('offline HTML embeds observed resources and reports resource failures honestly', async () => {
  const result = { platform: 'x', title: '<script>title</script>', status: 'captured', requested_url: 'https://x.com/a/status/1', items: [], limitations: [], presentation: { html: '<p>first</p><img src="https://pbs.twimg.com/a?x=1&amp;y=2"><p>last</p>', assets: [{ kind: 'image', url: 'https://pbs.twimg.com/a?x=1&y=2' }] } };
  const html = await htmlDocument(result, async () => new Response('png-bytes', { headers: { 'content-type': 'image/png' } }), { executionPolicy: testPolicy(tmp) });
  assert.equal(result.offline.embedded, 1);
  assert.match(html, /<p>first<\/p><img src="data:image\/png;base64,[^"]+"><p>last<\/p>/);
  assert.match(html, /&lt;script&gt;title/);
  const failed = structuredClone(result); failed.status = 'captured';
  await htmlDocument(failed, async () => new Response('denied', { status: 403 }), { executionPolicy: testPolicy(tmp) });
  assert.equal(failed.status, 'partial');
  assert.equal(failed.offline.failures[0].error, 'HTTP 403');
});

test('a rate-limited native search stops before public fallback routes', async () => {
  const browser = page([snapshot({ gate: 'rate_limited' })]);
  const result = await search(browser, opts('limited-search', { platform: 'xhs', query: '人工智能', read: 0, scrolls: 0 }));
  assert.equal(result.stop_reason, 'rate_limited'); assert.equal(result.attempts.length, 1); assert.equal(browser.opened.length, 1);
  assert.equal(result.discovered_candidates, 0);
});

test('HTML resource embedding stops on 429 and preserves missing asset evidence', async () => {
  let requests = 0;
  const result = { platform: 'x', title: 'test', requested_url: 'https://x.com/a/status/1', status: 'captured', items: [], limitations: [], presentation: { html: '<p>原文</p>', assets: [{ kind: 'image', url: 'https://example.com/one' }, { kind: 'image', url: 'https://example.com/two' }] } };
  await htmlDocument(result, async () => { requests++; return new Response('', { status: 429 }); }, { executionPolicy: testPolicy(tmp) });
  assert.equal(requests, 1); assert.equal(result.status, 'partial'); assert.equal(result.offline.failures.length, 2);
});

test('observed Article response media is limited to the target post and official image host', () => {
  const tweet = (id, url) => ({ rest_id: id, article: { article_results: { result: { media_entities: [{ media_id: '99', media_info: { original_img_url: url } }] } } } });
  const entry = { url: 'https://x.com/i/api/graphql/query/TweetDetail', responsePreview: JSON.stringify({ data: [tweet('123', 'https://pbs.twimg.com/media/original.jpg'), tweet('456', 'https://pbs.twimg.com/media/unrelated.jpg')] }) };
  assert.deepEqual(articleMediaFromNetwork([entry], '123'), { '99': { url: 'https://pbs.twimg.com/media/original.jpg', alt: '', source_status_id: '123' } });
  assert.deepEqual(articleMediaFromNetwork([{ ...entry, url: 'https://evil.test/i/api/graphql/query' }], '123'), {});
  assert.deepEqual(articleMediaFromNetwork([{ ...entry, responsePreview: JSON.stringify(tweet('123', 'http://127.0.0.1/secret')) }], '123'), {});
});


test('a task keeps pages and records in raw/ with their HTML inside, and its summary beside raw/', async () => {
  const options = opts('task-delivery');
  const output = options.out;
  const task = await createTaskArchive(output, 'one user request', {newTask: true, threadId: null});
  options.out = task;
  const captured = await capture(page([snapshot()]), options);
  assert.equal(path.dirname(captured.folder), path.join(task, 'raw'));
  assert.equal(path.dirname(captured.html_file), captured.folder);
  assert.deepEqual((await fs.readdir(task)).sort(), [`${path.basename(task)}.html`, 'raw']);
  assert.deepEqual(await fs.readdir(output), [path.basename(task)]);
  assert.deepEqual((await fs.readdir(captured.folder)).filter(name => !name.endsWith('.html')).sort(), ['content.json', 'identity.json', 'manifest.json', 'snapshots']);
  const manifest = JSON.parse(await fs.readFile(path.join(captured.folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.output_layout, 'archive_html_v2');
  assert.ok(manifest.files.every(entry => !entry.path.startsWith('raw/')));
  assert.ok((await verifyArchive(captured.folder)).ok);
  const resumed = await capture(page([snapshot()]), {...options, resume: true});
  assert.equal(resumed.folder, captured.folder);
  assert.equal(resumed.html_file, captured.html_file);
  assert.ok((await verifyArchive(resumed.folder)).ok);
});

test('search thumbnails preserve source URLs without spending any media operations', async () => {
  const source = 'https://example.com/search';
  const thumbnails = Array.from({length: 40}, (_, index) => ({kind: 'image', url: `https://example.com/${index}.png`}));
  const result = {query: 'AI poster', platform: 'web', requested_url: source, resolved_url: source, title: 'Search', status: 'captured', limitations: [], items: [], presentation: {html: '<img src="https://example.com/0.png"><a href="/article">Target</a>', assets: thumbnails}};
  let downloads = 0;
  const html = await htmlDocument(result, () => {downloads++; throw new Error('Search should not download thumbnails');}, {executionPolicy: testPolicy(tmp)});
  assert.equal(downloads, 0);
  assert.match(html, /https:\/\/example.com\/0.png/);
  assert.equal(result.offline.resources, 40);
  assert.equal(result.offline.remote_search_resources, true);
  assert.equal(result.offline.failures.length, 0);
  assert.equal(result.status, 'captured');
});


test('a requested media export defers page assets to the single archive downloader', async () => {
  const result = {platform: 'web', requested_url: 'https://example.com/article', resolved_url: 'https://example.com/article', title: 'Article', status: 'captured', limitations: [], items: [], presentation: {html: '<img src="https://example.com/photo.png">', assets: [{kind: 'image',url: 'https://example.com/photo.png'}]}};
  let requests = 0;
  const html = await htmlDocument(result, () => {requests++;}, {executionPolicy: testPolicy(tmp), deferMedia: true});
  assert.equal(requests, 0);
  assert.match(html, /https:\/\/example.com\/photo.png/);
  assert.equal(result.offline.media_export_deferred, true);
  assert.equal(result.offline.embedded, 0);
});
