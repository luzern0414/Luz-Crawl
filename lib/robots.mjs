import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateURL } from './platforms.mjs';
import { privateAddress } from './media.mjs';
import { VERSION } from './version.mjs';

// RFC 9309 (Robots Exclusion Protocol) matcher. It answers one question for the user before a bulk or repeated read:
// do the site's published crawl rules cover this path for this product token? The answer is advice, not access
// control: RFC 9309 section 1 says the rules are not a form of access authorization, and a rule that allows a path
// says nothing about the site's terms, copyright or personal-information limits (references/compliance.md).
export const PRODUCT_TOKEN = 'luzcrawl';
const MAX_BYTES = 512000; // RFC 9309 section 2.5: parse at least 500 KiB.

export function parseRobots(text) {
  const groups = [];
  let current = null, collecting = false;
  for (const raw of String(text || '').slice(0, MAX_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collecting || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      collecting = true;
    } else if (field === 'allow' || field === 'disallow') {
      collecting = false;
      if (current) current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

// A pattern matches from the start of path+query; `*` is any run of characters and a trailing `$` anchors the end.
function matches(pattern, target) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}${anchored ? '$' : ''}`).test(target);
}

/** Verdict for one path under parsed groups: the most specific rule wins and Allow wins a tie (RFC 9309 section 2.2.2). */
export function pathVerdict(groups, target, token = PRODUCT_TOKEN) {
  if (/^\/robots\.txt(?:$|\?)/.test(target)) return { allowed: true, agent_group: null, rule: null };
  const own = groups.filter((group) => group.agents.includes(token.toLowerCase()));
  const chosen = own.length ? own : groups.filter((group) => group.agents.includes('*'));
  const agentGroup = own.length ? token.toLowerCase() : chosen.length ? '*' : null;
  let best = null;
  for (const rule of chosen.flatMap((group) => group.rules)) {
    if (!rule.pattern || !matches(rule.pattern, target)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { ...rule, length };
  }
  return { allowed: best ? best.allow : true, agent_group: agentGroup, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` : null };
}

export function robotsVerdict(response, url, token = PRODUCT_TOKEN) {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}` || '/';
  const robots_url = `${parsed.origin}/robots.txt`;
  const status = response?.status;
  if (!Number.isInteger(status) || status >= 500) {
    // Unreachable: RFC 9309 section 2.3.1.4 requires assuming complete disallow.
    return { url: parsed.href, robots_url, outcome: 'unreachable', allowed: false, http_status: status ?? null, agent_group: null, rule: null, note: response?.error || 'robots.txt 无法取得，按 RFC 9309 视为全部禁止，稍后重试或请用户判断。' };
  }
  if (status >= 400) return { url: parsed.href, robots_url, outcome: 'unavailable', allowed: true, http_status: status, agent_group: null, rule: null, note: 'robots.txt 不存在（4xx），RFC 9309 允许访问；仍须遵守站点条款。' };
  if (status < 200 || status >= 300) return { url: parsed.href, robots_url, outcome: 'unreachable', allowed: false, http_status: status, agent_group: null, rule: null, note: 'robots.txt 返回了非预期状态，视为全部禁止。' };
  const verdict = pathVerdict(parseRobots(response.text), target, token);
  return { url: parsed.href, robots_url, outcome: verdict.allowed ? 'allowed' : 'disallowed', http_status: status, ...verdict, note: verdict.allowed ? '爬虫规则未禁止此路径；这不是站点授权，条款与版权、个人信息限制仍然适用。' : '站点的爬虫规则禁止此路径：不要对它做批量或持续采集，需要时请用户决定并记录。' };
}

async function assertPublicHost(hostname, lookupImpl) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error('robots.txt is only read from public hosts.');
}

export async function checkRobots(url, { fetchImpl = fetch, lookupImpl = lookup, timeoutMs = 10000 } = {}) {
  const parsed = validateURL(url);
  await assertPublicHost(parsed.hostname, lookupImpl);
  let target = `${parsed.origin}/robots.txt`;
  try {
    // RFC 9309 section 2.3.1.2: follow at least five redirects; every hop must stay on a public host.
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': `LuzCrawl/${VERSION} (robots.txt check)`, accept: 'text/plain,*/*;q=0.1' } });
      if (response.status >= 300 && response.status < 400 && response.headers?.get?.('location')) {
        const next = validateURL(new URL(response.headers.get('location'), target).href);
        await assertPublicHost(next.hostname, lookupImpl);
        target = next.href;
        continue;
      }
      // Still redirecting after five hops counts as unavailable (RFC 9309 section 2.3.1.2).
      if (response.status >= 300 && response.status < 400) return robotsVerdict({ status: 404 }, parsed.href);
      const text = response.status >= 200 && response.status < 300 ? (await response.text()).slice(0, MAX_BYTES) : '';
      return robotsVerdict({ status: response.status, text }, parsed.href);
    }
    return robotsVerdict({ status: 404 }, parsed.href);
  } catch (error) {
    return robotsVerdict({ status: null, error: `robots.txt 请求失败：${error.message}` }, parsed.href);
  }
}
