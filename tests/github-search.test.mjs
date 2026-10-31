import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { githubQueryPlan, githubSearchRoutes, rankGitHubCandidates } from '../lib/github-search.mjs';
import { CATALOG } from '../lib/platforms.mjs';
import { search, sourceCandidates } from '../lib/search.mjs';

const github = CATALOG.find((site) => site.id === 'github');

test('GitHub query planning decomposes a natural-language request into searchable facets', () => {
  const plan = githubQueryPlan('找一个支持微信登录、后台管理、中文、TypeScript 的开源 SaaS 项目');

  assert.equal(plan.original, '找一个支持微信登录、后台管理、中文、TypeScript 的开源 SaaS 项目');
  assert(plan.facets.intent.includes('wechat-auth'));
  assert(plan.facets.intent.includes('admin'));
  assert(plan.facets.technology.includes('typescript'));
  assert(plan.facets.constraints.includes('chinese'));
  assert(plan.queries.length >= 3);
  assert(plan.queries.some((item) => /wechat|oauth/i.test(item.query)));
  assert(plan.queries.some((item) => /language:typescript/i.test(item.query)));
  assert(plan.queries.every((item) => /is:public\b/.test(item.query)));
  assert(plan.queries.every((item) => /archived:false\b/.test(item.query)));
  assert(plan.queries.every((item) => /fork:false\b/.test(item.query)));
});

test('GitHub planning expands common Chinese product terms into repository vocabulary', () => {
  const plan = githubQueryPlan('本地部署微信小程序客服商城，支持权限、搜索和支付');

  assert(plan.facets.intent.includes('wechat-platform'));
  assert(plan.facets.intent.includes('customer-service'));
  assert(plan.facets.intent.includes('ecommerce'));
  assert(plan.facets.intent.includes('auth'));
  assert(plan.facets.intent.includes('search'));
  assert(plan.facets.intent.includes('payment'));
  assert(plan.queries.some((item) => /wechat mini program|customer service|e-commerce|rbac|elasticsearch/i.test(item.query)));
  assert(plan.queries.some((item) => /self-hosted/i.test(item.query)));
  const semantic = plan.queries.find((item) => item.id === 'semantic').query;
  assert(semantic.split(/\s+/).length < 18);
});

test('GitHub planning preserves reliability requirements such as retry and backoff', () => {
  const plan = githubQueryPlan('Python 爬虫 重试和退避');

  assert(plan.facets.intent.includes('crawler'));
  assert(plan.facets.intent.includes('retry'));
  assert(plan.queries.some((item) => /retry|backoff/i.test(item.query)));
});

test('GitHub preserves explicit qualifiers including commas, quotes and negative filters', () => {
  const plan = githubQueryPlan('browser automation org:microsoft language:TypeScript in:name,description stars:>25 fork:true -topic:selenium license:"apache-2.0"');
  for (const query of plan.queries) {
    for (const qualifier of ['org:microsoft', 'language:TypeScript', 'in:name,description', 'stars:>25', 'fork:true', '-topic:selenium', 'license:"apache-2.0"']) assert(query.query.includes(qualifier), qualifier);
    assert(!query.query.includes('fork:false'));
    assert(!query.query.includes('in:name,description,readme'));
    assert(!query.query.includes('language:typescript language:TypeScript'));
  }
  assert(!plan.search_terms.includes('microsoft'), 'qualifier values are filters, not functional evidence');
});

test('unknown English project needs retain searchable terms in semantic routes', () => {
  const plan = githubQueryPlan('music notation editor');
  assert(plan.search_groups.semantic.some(item => /music|notation|editor/.test(item)));
  assert(!plan.queries.some(item => !item.query.replace(/\S+:\S+/g, '').trim()), 'do not issue a qualifier-only query over all repositories');
});

test('keyword cleanup preserves domain nouns and avoids substring language or intent matches', () => {
  for (const noun of ['用户画像', '操作系统', '项目管理', '工具调用']) assert(githubQueryPlan(`找一个${noun}的开源项目`).normalized.includes(noun));
  const unknown = githubQueryPlan('forest mapping toolkit');
  assert(!unknown.facets.intent.includes('api'));
  assert(!unknown.facets.intent.includes('mobile'));
  const cpp = githubQueryPlan('C++ 爬虫');
  assert(cpp.queries.some(item => item.query.includes('language:c++')));
  assert(!cpp.queries.some(item => /language:c(?:\s|$)/i.test(item.query)));
  assert(githubQueryPlan('C# 爬虫').queries.some(item => item.query.includes('language:csharp')));
});

test('Bing and GitCN use plain terms instead of GitHub-only search syntax', () => {
  const routes = githubSearchRoutes(github, 'Python 爬虫 重试 org:scrapy');
  for (const route of routes.filter(item => !item.kind.startsWith('native'))) {
    assert(!/(?:in|language|stars|fork|archived|is|org):/i.test(route.query));
    assert(/crawler|retry|爬虫|重试/.test(route.query));
  }
  const bing = routes.find(item => item.kind === 'public_index');
  assert(new URL(bing.url).searchParams.get('q').startsWith('site:github.com '));
});

test('GitHub routes run multiple focused searches and a bounded public-index fallback', () => {
  const routes = githubSearchRoutes(github, 'python 爬虫 重试');

  assert(routes.length >= 4);
  assert(routes.filter((route) => route.kind.startsWith('native')).length >= 3);
  assert(routes.some((route) => route.kind === 'public_index'));
  assert(routes.every((route) => route.url.startsWith('https://')));
  assert(routes.some((route) => /s=stars&o=desc/.test(route.url)));
  assert(routes.some((route) => /stars%3A%3E10/.test(route.url)));
  assert(routes.some((route) => /site%3Agithub\.com|site:github\.com/.test(route.url)));
  assert(new Set(routes.map((route) => route.url)).size === routes.length);
  const qualityQuery = githubQueryPlan('browser automation Playwright').queries.find((item) => item.id === 'quality').query;
  assert.equal((qualityQuery.match(/browser automation/gi) || []).length, 1);
});

test('GitHub routes keep GitCN as a bounded fallback with a real form entry', () => {
  const routes = githubSearchRoutes(github, 'browser automation Playwright');
  const mirror = routes.find((route) => route.kind === 'mirror');

  assert(mirror, 'GitCN should be available after native and public-index routes');
  assert.equal(mirror.url, 'https://gitcn.org/search');
  assert.deepEqual(mirror.form, { mode: 'form', entry_url: 'https://gitcn.org/search', query_parameter: 'q' });
  assert.equal(mirror.candidate_site.id, 'gitcn');
  assert.deepEqual(mirror.candidate_site.result_domains, ['github.com']);
  assert(routes.indexOf(mirror) > routes.findIndex((route) => route.kind === 'public_index'));
  assert(routes.length <= 7, 'fallback routes must stay bounded');
});

test('GitCN candidates require a GitHub repository URL and card context', () => {
  const gitcn = CATALOG.find((site) => site.id === 'gitcn');
  const content = {
    requested_url: 'https://gitcn.org/search',
    links: [
      {
        url: 'https://github.com/example/browser-automation',
        text: 'example/browser-automation',
        context: 'example/browser-automation Browser automation with Playwright and Python 1.2k stars'
      },
      {
        url: 'https://github.com/topics/browser-automation',
        text: 'browser automation',
        context: 'Topics browser automation'
      },
      {
        url: 'https://gitcn.org/download/example/browser-automation.zip',
        text: '下载',
        context: '下载 browser automation project'
      },
      {
        url: 'https://github.com/example/unrelated',
        text: 'example/unrelated',
        context: 'A popular JavaScript framework 90k stars'
      }
    ]
  };

  const candidates = sourceCandidates(content, gitcn, true, 'browser automation');
  assert.deepEqual(candidates.map((item) => item.url), ['https://github.com/example/browser-automation']);
  assert.equal(candidates[0].search_evidence.context, true);
});

test('GitCN does not treat AtomGit mirror paths as GitHub originals', () => {
  const gitcn = CATALOG.find((site) => site.id === 'gitcn');
  const candidates = sourceCandidates({
    requested_url: 'https://gitcn.org/search',
    links: [{
      url: 'https://atomgit.com/gh_mirrors/br/browser-automation',
      text: 'browser-automation',
      context: 'browser automation mirror'
    }]
  }, gitcn, true, 'browser automation');

  assert.equal(candidates.length, 0);
});

test('explicit archive and fork queries survive candidate filtering and ranking', () => {
  const links = [
    { url: 'https://github.com/example/browser-automation', text: 'example/browser-automation', context: 'Browser automation toolkit. Archived. Forked from upstream/browser-automation. 120 stars' }
  ];
  const content = { requested_url: 'https://github.com/search', links };
  assert.equal(sourceCandidates(content, github, false, 'browser automation').length, 0);
  const plan = githubQueryPlan('browser automation archived:true fork:only');
  const found = sourceCandidates(content, github, false, plan.queries[0].query);
  assert.equal(found.length, 1);
  assert(rankGitHubCandidates(found, plan)[0].github_score > 0, 'explicitly requested repository kinds must not be penalized as unwanted');
});

test('repository discovery rejects a bare matching link without result-card context', () => {
  assert.equal(sourceCandidates({ requested_url: 'https://github.com/search', links: [{ url: 'https://github.com/example/browser-automation', text: 'browser automation' }] }, github, false, 'browser automation').length, 0);
});

test('GitHub candidates combine relevance with repository quality signals', () => {
  const plan = githubQueryPlan('Python 爬虫');
  const ranked = rankGitHubCandidates([
    { url: 'https://github.com/example/low-signal', text: 'example/low-signal Python crawler 2 stars 0 forks' },
    { url: 'https://github.com/example/high-signal', text: 'example/high-signal Python crawler 12.4k stars 1.1k forks' },
    { url: 'https://github.com/example/unrelated', text: 'example/unrelated 90k stars JavaScript framework' },
    { url: 'https://github.com/example/archived', text: 'example/archived Python crawler 30k stars archived' }
  ], plan);

  assert.equal(ranked[0].url, 'https://github.com/example/high-signal');
  assert.equal(ranked.at(-1).url, 'https://github.com/example/archived');
  assert(ranked[0].github_signals.stars > 10000);
  assert(ranked[0].github_score > ranked[1].github_score);
  assert(ranked.some((item) => item.url.endsWith('/unrelated')));
});

test('GitHub signals read compact result-card star metrics', () => {
  const ranked = rankGitHubCandidates([
    { url: 'https://github.com/example/card', context: 'example/card\nPython\n·\n32.6k\n·\nUpdated 15 hours ago\nStar' },
    { url: 'https://github.com/example/label', text: 'example/label 1.2k stars' }
  ], githubQueryPlan('Python'));

  assert.equal(ranked.find((item) => item.url.endsWith('/card')).github_signals.stars, 32600);
  assert.equal(ranked.find((item) => item.url.endsWith('/label')).github_signals.stars, 1200);
});

test('GitHub quality signals cannot outrank a core-intent repository', () => {
  const plan = githubQueryPlan('自托管微信客服后台，支持权限管理和 TypeScript');
  const ranked = rankGitHubCandidates([
    { url: 'https://github.com/googleapis/google-api-nodejs-client', context: "googleapis/google-api-nodejs-client\nGoogle's Node.js client library for authorization and authentication with OAuth 2.0\n12.3k · Updated 2 days ago · Star" },
    { url: 'https://github.com/example/wechat-admin', context: 'example/wechat-admin\nWechat customer service admin dashboard with permissions and TypeScript\n3 stars · Updated yesterday · Star' }
  ], plan);

  assert.equal(ranked[0].url, 'https://github.com/example/wechat-admin');
  assert(ranked[0].github_core_matched_terms.includes('wechat'));
  assert.equal(ranked[1].github_core_matched_terms.length, 0);
});

test('GitHub search executes focused routes and merges duplicate repositories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-github-search-'));
  const out = path.join(root, 'out');
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  const calls = [];
  const capturePage = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `route-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    const links = calls.length === 1
      ? [{ url: 'https://github.com/example/project', text: 'example/project', context: 'Python crawler for collecting web pages 1k stars' }]
      : [{ url: 'https://github.com/example/project', text: 'example/project', context: 'Python crawler for collecting web pages 1k stars' }, { url: 'https://github.com/example/second', text: 'example/second', context: 'Python scraper for collecting web pages 500 stars' }, { url: 'https://github.com/example/noise', text: 'example/noise', context: 'An unrelated audio editing project' }];
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: 'GitHub repository search results', links }));
    return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
  };
  try {
    const result = await search({}, { platform: 'github', query: 'python 爬虫', read: 1, out }, { summary: () => ({}) }, capturePage);
    assert(result.query_plan.queries.length >= 3);
    assert(calls.length >= 3);
    assert(calls.filter((options) => options.query).every((options) => options.scrolls <= 1), 'GitHub discovery must keep one search route from consuming the whole operation window');
    assert(calls.filter((options) => !options.query).every((options) => options.scrolls <= 8), 'GitHub detail reads must stay bounded');
    assert(calls.every((options) => options.screenshot === false), 'GitHub searches should save structured evidence and defer screenshots');
    assert(result.attempts.some((attempt) => attempt.query_variant));
    assert.equal(result.candidates.filter((item) => item.url.endsWith('/project')).length, 1);
    assert(!result.candidates.some((item) => item.url.endsWith('/noise')));
    assert.equal(result.candidates[0].github_signals.stars, 1000);
    assert.equal(result.verified_sources, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub detail reads continue after an unavailable top candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-github-detail-retry-'));
  const out = path.join(root, 'out');
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  const calls = [];
  const capturePage = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `route-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    const discovery = Boolean(options.query);
    const links = discovery ? [
      { url: 'https://github.com/example/unavailable', text: 'example/unavailable', context: 'Python crawler for collecting web pages 10k stars' },
      { url: 'https://github.com/example/usable', text: 'example/usable', context: 'Python crawler for collecting web pages 100 stars' },
    ] : [];
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: 'GitHub repository page', links }));
    if (discovery) return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
    const usable = options.url.endsWith('/usable');
    return {
      folder,
      status: usable ? 'captured' : 'partial',
      stop_reason: usable ? 'stable_after_3_scrolls' : 'unavailable',
      resolved_url: options.url,
      url_check: { valid_content: usable },
      limitations: usable ? [] : ['unavailable'],
    };
  };
  try {
    const result = await search({}, { platform: 'github', query: 'python 爬虫', read: 1, out }, { summary: () => ({}) }, capturePage);
    const detailCalls = calls.filter((options) => !options.query);
    assert.equal(detailCalls.length, 2, 'a failed first detail should not prevent the next candidate from being read');
    assert.equal(result.verified_sources, 1);
    assert.equal(result.sources.find((item) => item.url.endsWith('/usable')).status, 'captured');
    assert.equal(result.status, 'captured');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub detail reads keep searching after several unavailable candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-github-detail-cushion-'));
  const out = path.join(root, 'out');
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  const calls = [];
  const capturePage = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `route-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    const discovery = Boolean(options.query);
    const links = discovery ? [1, 2, 3, 4].map((number) => ({
      url: `https://github.com/example/candidate-${number}`,
      text: `example/candidate-${number}`,
      context: `Python crawler for collecting web pages ${100 - number} stars`,
    })) : [];
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: 'GitHub repository page', links }));
    if (discovery) return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
    const usable = options.url.endsWith('/candidate-4');
    return { folder, status: usable ? 'captured' : 'partial', stop_reason: usable ? 'stable_after_3_scrolls' : 'unavailable', resolved_url: options.url, url_check: { valid_content: usable }, limitations: [] };
  };
  try {
    const result = await search({}, { platform: 'github', query: 'python 爬虫', read: 1, out }, { summary: () => ({}) }, capturePage);
    const detailCalls = calls.filter((options) => !options.query);
    assert.equal(detailCalls.length, 4, 'the fallback cushion should reach the fourth candidate');
    assert.equal(result.verified_sources, 1);
    assert.equal(result.sources.at(-1).url, 'https://github.com/example/candidate-4');
    assert.equal(result.status, 'captured');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub search uses GitCN only after native and Bing discovery miss', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-gitcn-fallback-'));
  const out = path.join(root, 'out');
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  const calls = [];
  const capturePage = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `route-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    const mirror = options.search_form?.entry_url === 'https://gitcn.org/search';
    const links = mirror ? [{
      url: 'https://github.com/example/browser-automation',
      text: 'example/browser-automation',
      context: 'Browser automation with Playwright and Python 1.2k stars'
    }] : [];
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: 'Search results', links }));
    return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
  };
  try {
    const result = await search({}, { platform: 'github', query: 'browser automation Playwright', read: 0, out }, { summary: () => ({}) }, capturePage);
    const mirrorIndex = calls.findIndex((options) => options.search_form?.entry_url === 'https://gitcn.org/search');
    assert(mirrorIndex >= 0, 'GitCN should run when all earlier discovery routes miss');
    assert(calls.slice(0, mirrorIndex).every((options) => options.search_form?.entry_url !== 'https://gitcn.org/search'));
    assert.equal(result.attempts[mirrorIndex].route_kind, 'mirror');
    assert.equal(result.candidates[0].url, 'https://github.com/example/browser-automation');
    assert.equal(result.attempts[mirrorIndex].source_platform, 'gitcn');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub search skips GitCN when a native route already has a candidate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luzcrawl-gitcn-skip-'));
  const out = path.join(root, 'out');
  process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
  const calls = [];
  const capturePage = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `route-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    const links = calls.length === 1 ? [{
      url: 'https://github.com/example/browser-automation',
      text: 'example/browser-automation',
      context: 'Browser automation with Playwright 1.2k stars'
    }] : [];
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: 'Search results', links }));
    return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
  };
  try {
    await search({}, { platform: 'github', query: 'browser automation', read: 0, out }, { summary: () => ({}) }, capturePage);
    assert(!calls.some((options) => options.search_form?.entry_url === 'https://gitcn.org/search'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
