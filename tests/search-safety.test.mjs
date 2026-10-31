import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { search, sourceCandidates } from '../lib/search.mjs';
import { OperationError } from '../lib/failure.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-search-safety-'));
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  t.after(async () => {
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE; else process.env.LUZ_CRAWL_STATE = previousState;
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls = [];
  const capture = handler => async (_page, options) => {
    calls.push(options);
    const value = handler(options, calls.length);
    const folder = path.join(root, `capture-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    await fs.writeFile(path.join(folder, 'raw/content.json'), JSON.stringify({ requested_url: options.url, text: value.text || 'Search results', links: value.links || [] }));
    return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [], ...value };
  };
  return { root, calls, capture };
}

test('Bing candidates suppress the later GitCN fallback even with fewer than five hits', async t => {
  const f = await fixture(t);
  const result = await search({}, { platform: 'github', query: 'browser automation', read: 0, out: f.root }, { summary: () => ({}) }, f.capture(options => ({
    links: options.url.includes('bing.com') ? [{ url: 'https://github.com/example/browser-automation', text: 'example/browser-automation', context: 'Browser automation CLI for testing real pages' }] : []
  })));
  assert.equal(result.discovered_candidates, 1);
  assert(!f.calls.some(options => options.url.startsWith('https://gitcn.org/')));
  assert(result.candidates[0].filters_require_detail_check.includes('archived:false'));
  assert(result.attempts.find(attempt => attempt.route_kind === 'public_index').filters_require_detail_check.includes('fork:false'));
});

for (const code of ['rate_limited', 'operation_budget', 'verification_required', 'cancelled']) {
  test(`thrown ${code} stops discovery before a fallback or detail request`, async t => {
    const f = await fixture(t);
    const result = await search({}, { platform: 'github', query: 'browser automation', read: 1, out: f.root }, { summary: () => ({}) }, f.capture(() => { throw new OperationError(code, 'Test terminal condition'); }));
    assert.equal(f.calls.length, 1);
    assert.equal(result.stop_reason, code);
    assert.equal(result.attempts[0].stop_reason, code);
    if (code === 'verification_required') {
      assert.equal(result.status, 'awaiting_user');
      assert.equal(result.requires_user, true);
      assert.equal(result.handover_url, f.calls[0].url);
    }
  });
}

test('a captured verification gate stops before public-index fallback', async t => {
  const f = await fixture(t);
  const result = await search({}, { platform: 'github', query: 'browser automation', read: 0, out: f.root }, { navigate: async () => {}, summary: () => ({}) }, f.capture(() => ({ status: 'blocked', stop_reason: 'verification_required', url_check: { valid_content: false } })));
  assert.equal(f.calls.length, 1);
  assert.equal(result.status, 'awaiting_user');
});

test('repository misses never harvest unrelated search-engine controls', async t => {
  const f = await fixture(t);
  let harvestCalls = 0;
  const operations = { summary: () => ({}), navigate: async () => { harvestCalls++; throw new Error('Unexpected click harvest'); } };
  const result = await search({}, { platform: 'codeberg', query: 'browser automation', read: 0, out: f.root }, operations, f.capture(() => ({ text: 'browser automation. No projects found.', links: [{ url: 'https://cn.bing.com/search?q=browser+automation', text: 'browser automation', context: 'Related searches browser automation' }] })));
  assert.equal(result.discovered_candidates, 0);
  assert.equal(harvestCalls, 0);
  assert(f.calls.every(options => options.scrolls <= 1 && options.screenshot === false));
});

test('GitLab repository candidates exclude issue, blob and star subpages', () => {
  const site = {domains:['gitlab.com'],repository_search:true,detail:'^https://gitlab\\.com/(?!explore/)[^/]+(?:/[^/]+)+$'};
  const urls = ['https://gitlab.com/group/nested/browser-automation', 'https://gitlab.com/group/nested/browser-automation/-/issues', 'https://gitlab.com/group/nested/browser-automation/-/blob/main/README.md', 'https://gitlab.com/group/nested/browser-automation/-/starrers'];
  const found = sourceCandidates({ requested_url: 'https://gitlab.com/explore/projects', links: urls.map(url => ({ url, text: 'browser automation', context: 'Browser automation project for real web pages' })) }, site, false, 'browser automation');
  assert.deepEqual(found.map(item => item.url), urls.slice(0, 1));
});

test('repository paths can contain ordinary words reserved by site navigation', () => {
  const site = { domains: ['gitlab.com'], repository_search: true, detail: '^https://gitlab\\.com/(?!explore/)[^/]+(?:/[^/]+)+$' };
  const urls = ['https://gitlab.com/group/users/browser-automation', 'https://gitlab.com/browser-automation/help'];
  const found = sourceCandidates({ requested_url: 'https://gitlab.com/explore/projects', links: urls.map(url => ({ url, text: 'browser automation', context: 'Browser automation project for real web pages' })) }, site, false, 'browser automation');
  assert.deepEqual(found.map(item => item.url), urls);
});

test('verification on an alternate discovery route is still a manual handoff', async t => {
  const f = await fixture(t);
  const result = await search({}, { platform: 'github', query: 'browser automation', read: 0, out: f.root }, { summary: () => ({}) }, f.capture(options => options.url.includes('gitcn.org') ? { status: 'blocked', stop_reason: 'verification_required', url_check: { valid_content: false } } : {}));
  assert.equal(result.status, 'awaiting_user');
  assert.equal(result.awaiting_reason, 'verification_required');
  assert.equal(result.handover_url, 'https://gitcn.org/search');
});

test('unconfirmed form submission cannot promote a popular project to a search hit', async t => {
  const f = await fixture(t);
  const result = await search({}, { platform: 'gitcn', query: 'browser automation', read: 0, out: f.root }, { summary: () => ({}) }, f.capture(() => ({ search_action: { submitted: true, effect_verified: false }, links: [{ url: 'https://github.com/example/browser-automation', text: 'browser automation', context: 'Browser automation popular project before search ran' }] })));
  assert.equal(result.discovered_candidates, 0);
  assert.equal(result.search_performed, false);
});

test('quoted qualifier values do not become functional result evidence', () => {
  const site = {domains:['github.com'],repository_search:true,detail:'^https://github\\.com/[^/]+/[^/]+$'};
  const found = sourceCandidates({requested_url:'https://github.com/search',links:[{url:'https://github.com/example/notebook',text:'Notebook automation',context:'Notebook automation tools for data analysis'}]}, site, false, 'browser automation language:"Jupyter Notebook"');
  assert.equal(found.length, 0);
});

test('a captured detail without positive content validation does not satisfy read count', async t => {
  const f = await fixture(t);
  const result = await search({}, {platform:'github',query:'browser automation',read:1,out:f.root}, {summary:()=>({})}, f.capture(options => options.query ? {links:[{url:'https://github.com/example/browser-automation',text:'browser automation',context:'Browser automation CLI for testing real pages'}]} : {url_check:undefined}));
  assert.equal(result.verified_sources, 0);
  assert.equal(result.status, 'partial');
});
