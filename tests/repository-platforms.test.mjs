import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../lib/platforms.mjs';
import { sourceCandidates } from '../lib/search.mjs';

function site(id) {
  const value = CATALOG.find((item) => item.id === id);
  assert(value, `catalog must contain ${id}`);
  return value;
}

test('repository discovery catalog includes verified alternate sources', () => {
  const gitcn = site('gitcn');
  assert(gitcn.aliases.includes('github中文社区'));
  assert.equal(gitcn.form_url, 'https://gitcn.org/search');
  assert.deepEqual(gitcn.result_domains, ['github.com']);
  assert.equal(gitcn.external_results, true);

  assert(!CATALOG.some(item => item.id === 'gitcode' || item.id === 'gitlab'), 'unconfirmed form routes stay in the candidate library');
  assert.equal(site('codeberg').search, 'https://codeberg.org/explore/repos?q={query}&sort=recentupdate&language=');
});

test('HelloGitHub accepts project cards and excludes articles, images and empty navigation', () => {
  const hello = site('hellogithub');
  assert.equal(hello.form_url, 'https://hellogithub.com/');
  assert.equal(hello.query_parameter, 'q');
  const urls = ['https://hellogithub.com/repository/browseros-ai/BrowserOS', 'https://hellogithub.com/article/browser', 'https://hellogithub.com/favicon.png', 'https://hellogithub.com/repository/browseros-ai/BrowserOS/issues'];
  const candidates = sourceCandidates({ requested_url: hello.form_url, links: urls.map(url => ({ url, text: '浏览器 BrowserOS', context: '浏览器 BrowserOS：可通过 AI 控制的开源浏览器项目' })) }, hello, false, '浏览器');
  assert.deepEqual(candidates.map(item => item.url), urls.slice(0, 1));
});

test('GitLab and Codeberg keep their own repository URLs as candidates', () => {
  const content = {
    requested_url: 'https://example.invalid/results',
    links: [
      { url: 'https://gitlab.com/group/browser-automation', text: 'group/browser-automation', context: 'Browser automation with Playwright 1.2k stars' },
      { url: 'https://gitlab.com/explore/projects', text: 'Explore projects', context: 'Explore projects Browser automation' },
      { url: 'https://codeberg.org/example/browser-automation', text: 'example/browser-automation', context: 'Browser automation with Python 200 likes' },
      { url: 'https://codeberg.org/explore/repos', text: 'Explore repositories', context: 'Explore browser automation repositories' }
    ]
  };

  const gitlab = sourceCandidates(content, {domains:['gitlab.com'], repository_search:true, detail:'^https://gitlab\\.com/(?!explore/)[^/]+/[^/]+$'}, false, 'browser automation');
  const codeberg = sourceCandidates(content, site('codeberg'), false, 'browser automation');
  assert.deepEqual(gitlab.map((item) => item.url), ['https://gitlab.com/group/browser-automation']);
  assert.deepEqual(codeberg.map((item) => item.url), ['https://codeberg.org/example/browser-automation']);
});
