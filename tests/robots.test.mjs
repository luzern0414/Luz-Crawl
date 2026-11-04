import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, pathVerdict, robotsVerdict, checkRobots } from '../lib/robots.mjs';

const verdict = (text, target, token) => pathVerdict(parseRobots(text), target, token);

test('the most specific rule wins and Allow wins a tie (RFC 9309 section 2.2.2)', () => {
  const text = 'User-agent: *\nDisallow: /repo/\nAllow: /repo/public/\nDisallow: /same\nAllow: /same';
  assert.equal(verdict(text, '/repo/private/a').allowed, false);
  assert.deepEqual(verdict(text, '/repo/public/a'), { allowed: true, agent_group: '*', rule: 'Allow: /repo/public/' });
  assert.equal(verdict(text, '/same').allowed, true);
  assert.equal(verdict(text, '/elsewhere').allowed, true);
});

test('wildcards, the end anchor and query strings match as documented', () => {
  const text = 'User-agent: *\nDisallow: /*/tree/\nDisallow: /*?q=*\nDisallow: /private$\nAllow: /private$';
  assert.equal(verdict(text, '/owner/repo/tree/main').allowed, false);
  assert.equal(verdict(text, '/owner/repo/blob/main').allowed, true);
  assert.equal(verdict(text, '/search?q=crawler').allowed, false);
  assert.equal(verdict('User-agent: *\nDisallow: /private$', '/private').allowed, false);
  assert.equal(verdict('User-agent: *\nDisallow: /private$', '/private/page').allowed, true);
});

test('a group for the product token replaces the * group and matching groups are combined', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: LuzCrawl\nDisallow: /admin\n\nUser-agent: luzcrawl\nDisallow: /tmp';
  assert.equal(verdict(text, '/page').allowed, true);
  assert.equal(verdict(text, '/admin/x').allowed, false);
  assert.equal(verdict(text, '/tmp').allowed, false);
  assert.equal(verdict(text, '/page', 'someothercrawler').allowed, false);
  assert.equal(verdict(text, '/page', 'someothercrawler').agent_group, '*');
  // consecutive User-agent lines share one group; a blank Disallow allows everything
  assert.equal(verdict('User-agent: a\nUser-agent: luzcrawl\nDisallow:\n', '/x').allowed, true);
  assert.equal(verdict('user-AGENT: luzcrawl\nDISALLOW: /x # comment', '/x').allowed, false);
});

test('robots.txt itself is always readable', () => {
  assert.equal(verdict('User-agent: *\nDisallow: /', '/robots.txt').allowed, true);
});

test('4xx means unavailable (allowed), 5xx and failures mean unreachable (disallowed)', () => {
  const url = 'https://example.org/a/b?x=1';
  assert.deepEqual([404, 410, 401].map((status) => robotsVerdict({ status }, url)).map((v) => [v.outcome, v.allowed]), [['unavailable', true], ['unavailable', true], ['unavailable', true]]);
  assert.deepEqual([500, 503].map((status) => robotsVerdict({ status }, url)).map((v) => [v.outcome, v.allowed]), [['unreachable', false], ['unreachable', false]]);
  assert.equal(robotsVerdict({ status: null, error: 'timeout' }, url).allowed, false);
  assert.equal(robotsVerdict({ status: 200, text: 'User-agent: *\nDisallow: /a/' }, url).outcome, 'disallowed');
  assert.equal(robotsVerdict({ status: 200, text: 'User-agent: *\nDisallow: /z/' }, url).outcome, 'allowed');
  assert.equal(robotsVerdict({ status: 200, text: '' }, url).robots_url, 'https://example.org/robots.txt');
});

test('published rules from the platforms the skill collects behave as read on 2026-11-02', () => {
  // https://www.xiaohongshu.com/robots.txt: every crawler except a few search engines is disallowed.
  const xhs = 'User-agent: Googlebot\nDisallow: /\nAllow: /worldcup26\n\nUser-agent: *\nDisallow: /\n';
  assert.equal(verdict(xhs, '/explore/abc').allowed, false);
  // https://github.com/robots.txt (excerpt): search pages and ?q= are disallowed for generic crawlers.
  const github = 'User-agent: *\nDisallow: /search$\nDisallow: /*?q=*\nDisallow: /*/tree/\n';
  assert.equal(verdict(github, '/search').allowed, false);
  assert.equal(verdict(github, '/search?q=browser+automation').allowed, false);
  assert.equal(verdict(github, '/microsoft/playwright').allowed, true);
});

const publicHost = async () => [{ address: '93.184.216.34' }];
const ROBOTS_NEWS = ['User-agent: *', 'Disallow: /news/'].join('\n');
const ROBOTS_OPEN = ['User-agent: *', 'Disallow:'].join('\n');

test('checkRobots fetches only /robots.txt of the origin and reports transport failures as unreachable', async () => {
  const seen = [];
  const answer = await checkRobots('https://example.org/news/1?id=7', { lookupImpl: publicHost, fetchImpl: async (url, init) => { seen.push([url, init.headers['user-agent']]); return { status: 200, text: async () => ROBOTS_NEWS }; } });
  assert.deepEqual(seen.map(([url]) => url), ['https://example.org/robots.txt']);
  assert.match(seen[0][1], /^LuzCrawl\/\d/);
  assert.equal(answer.outcome, 'disallowed');
  const failed = await checkRobots('https://example.org/', { lookupImpl: publicHost, fetchImpl: async () => { throw new Error('connection reset'); } });
  assert.equal(failed.outcome, 'unreachable');
  assert.equal(failed.allowed, false);
});

test('redirects are followed up to five hops and never into private addresses', async () => {
  let calls = 0;
  const redirect = (location) => ({ status: 301, headers: new Headers({ location }), text: async () => '' });
  const followed = await checkRobots('https://example.org/a', { lookupImpl: publicHost, fetchImpl: async (url) => { calls++; return url.endsWith('/robots.txt') && calls === 1 ? redirect('https://www.example.org/robots.txt') : { status: 200, text: async () => ROBOTS_OPEN }; } });
  assert.equal(followed.outcome, 'allowed');
  assert.equal(calls, 2);
  const endless = await checkRobots('https://example.org/a', { lookupImpl: publicHost, fetchImpl: async () => redirect('https://example.org/robots.txt') });
  assert.equal(endless.outcome, 'unavailable');
  const toPrivate = await checkRobots('https://example.org/a', { lookupImpl: async (host) => [{ address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34' }], fetchImpl: async () => redirect('https://internal.example/robots.txt') });
  assert.equal(toPrivate.outcome, 'unreachable');
  await assert.rejects(() => checkRobots('http://127.0.0.1/admin'), /public hosts/);
  await assert.rejects(() => checkRobots('https://intranet.example/', { lookupImpl: async () => [{ address: '192.168.1.8' }] }), /public hosts/);
});
