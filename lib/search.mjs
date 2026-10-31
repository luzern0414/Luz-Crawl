import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture } from './capture.mjs';
import { clickSearchResult } from './extract-page.mjs';
import { resolveSite } from './memory.mjs';
import { canonicalURL, decodedLink, validateURL, sourceURL } from './platforms.mjs';
import { atomicWrite, createTaskArchive, DEFAULT_OUTPUT, findTaskArchive, recordExperience } from './archive.mjs';
import { createBrowserOperations } from './browser-operations.mjs';
import { VERSION } from './version.mjs';
import { classifyFailure } from './failure.mjs';
import { githubQueryPlan, githubSearchRoutes, rankGitHubCandidates, githubRepositoryFilters } from './github-search.mjs';
import { expandSocialQueries, selectAdaptiveBudget } from './social-schema.mjs';

// Search engines routinely rewrite a result title (for example, "数字教材"
// becomes "数字配套资源").  Keep the expansion deliberately small and use it
// only as result-card evidence; it must never replace the user's query.
const SEARCH_TERM_ALIASES = new Map([
  ['官方', ['官网', '官方网站', '官方资源', '出版社']],
  ['教材', ['教科书', '课本', '电子教材', '数字教材']],
  ['数字教材', ['数字资源', '配套资源', '电子教材', '电子课本', '数字课本']],
  ['小学英语', ['英语教材', '英语课本', '小学英语', '三年级', '四年级']],
  ['人教版', ['人教', '人民教育', 'pep']],
  ['音频', ['课文音频', '听力', '朗读', 'mp3', 'audio']],
  ['视频', ['录像', '视频课程', 'video']],
  ['图片', ['图像', '照片', 'image']],
  ['下载', ['资源', 'download']],
  ['教程', ['指南', '文档', 'tutorial', 'guide']],
  ['开源', ['open source', 'opensource', 'github']],
  ['爬虫', ['crawler', 'scraper', 'spider', 'web scraping']],
  ['抓取', ['crawler', 'scraper', 'spider', 'web scraping']],
  ['采集', ['crawler', 'scraper', 'spider', 'web scraping']],
  ['重试', ['retry', 'retries', 'backoff']],
  ['退避', ['backoff', 'retry']],
  ['容错', ['resilience', 'fault tolerant', 'fault-tolerant']],
  ['登录', ['login', 'signin', 'authentication', 'auth']],
  ['认证', ['authentication', 'authorization', 'auth']],
  ['权限', ['permission', 'permissions', 'rbac', 'authorization']],
  ['支付', ['payment', 'checkout', 'billing']],
  ['客服', ['customer service', 'helpdesk', 'support']],
  ['微信', ['wechat', 'weixin']],
  ['小程序', ['mini program', 'miniprogram', 'wechat']],
  ['后台', ['admin', 'dashboard', 'backoffice']],
  ['中文', ['chinese', 'zh-cn', 'zh language']],
  ['本地部署', ['self-hosted', 'self hosted', 'on-premise', 'on premise']],
  ['自托管', ['self-hosted', 'self hosted', 'on-premise', 'on premise']]
]);

const SEARCH_QUALIFIER = /^-?(?:site|in|language|stars|forks?|pushed|created|topic|user|org|repo|license|size|is|archived|mirror|sort):/i;
const DISCOVERY_STOPS = new Set(['rate_limited', 'operation_budget', 'cancelled', 'verification_required', 'access_denied', 'write_outcome_unknown']);

function compactSearchText(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/\s+/g, '');
}

function searchText(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function variantsForTerm(term) {
  const value = String(term || '').trim().toLowerCase().normalize('NFKC');
  if (!value) return [];
  const variants = [value, ...(SEARCH_TERM_ALIASES.get(value) || [])];
  // Chinese result titles often keep one meaningful two-character phrase but
  // drop the rest of a long query.  Two-character shingles recover that
  // signal without accepting a one-character coincidence.
  if (/\p{Script=Han}/u.test(value) && [...value].length >= 3) {
    const chars = [...value];
    for (let index = 0; index < chars.length - 1; index++) variants.push(chars.slice(index, index + 2).join(''));
  }
  return [...new Set(variants.map((item) => String(item).toLowerCase().trim()).filter((item) => item.length >= 2))];
}

function searchTermEvidence(term, value) {
  const normalized = searchText(value);
  const compact = compactSearchText(value);
  const variants = variantsForTerm(term);
  const exact = variants[0] && (/\p{Script=Han}/u.test(variants[0]) ? compact.includes(compactSearchText(variants[0])) : normalized.includes(variants[0]));
  const matched = variants.filter((variant) => (/\p{Script=Han}/u.test(variant) ? compact.includes(compactSearchText(variant)) : normalized.includes(variant)));
  return { term, exact: Boolean(exact), matched: [...new Set(matched)] };
}

function genericResultLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return /^(?:阅读更多|查看更多|查看详情|详情|更多|more|read more|view more|click|点击|打开|open|link|链接|翻译此结果|translate this result)$/i.test(text)
    || /(?:在github\.com上查看更多信息|github\.com\s*[›>]|^https?:\/\/github\.com\s*[›>])/i.test(text);
}

function contextResultLabel(value) {
  const lines = String(value || '').split(/[\r\n]+/).map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => item.length >= 8 && item.length <= 180);
  return lines.find((item) => !/^https?:\/\//i.test(item) && !/^www\./i.test(item) && !/^©|^copyright|版权所有/i.test(item) && !/仅显示来自|搜索结果$/i.test(item)) || lines[0] || String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function repositoryResultLabel(url) {
  try {
    const parsed = validateURL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '';
  } catch { return ''; }
}

// A click-only harvest can learn a destination URL even when the search page
// did not expose ordinary result links.  Keep that fallback inside the
// platform's repository boundary; otherwise clicking a Bing suggestion or
// the search page itself would be reported as a project candidate.
export function repositoryURLAllowed(url, site) {
  try {
    const parsed = validateURL(url);
    const domains = (site?.result_domains?.length ? site.result_domains : site?.domains || [])
      .map((domain) => String(domain).replace(/^www\./i, '').toLowerCase());
    if (domains.length && !domains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return false;
    if (site?.detail && !new RegExp(site.detail, 'i').test(parsed.href)) return false;
    if (site?.repository_search && (/\/-\//.test(parsed.pathname) || /^\/(?:explore|search|topics?|users?|snippets?|settings|dashboard|notifications)(?:\/|$)/i.test(parsed.pathname))) return false;
    return true;
  } catch { return false; }
}

function conflictsWithQuery(query, label) {
  const wanted = compactSearchText(query);
  const own = compactSearchText(label);
  if (!wanted || !own) return false;
  if (/小学|elementary|primaryschool/.test(wanted) && /七年级|八年级|九年级|初中|高中|middle school|high school/.test(own)) return true;
  if (/初中|middle school/.test(wanted) && /小学|三年级|四年级|五年级|六年级|elementary|primaryschool/.test(own)) return true;
  if (/高中|high school/.test(wanted) && /小学|初中|三年级|四年级|五年级|六年级|七年级|八年级|九年级|elementary|middle school/.test(own)) return true;
  return false;
}

export function sourceCandidates(content, site, external = false, query = '') {
  const seen = new Set();
  const pattern = site.detail ? new RegExp(site.detail, 'i') : null;
  const candidateDomains = (site.result_domains?.length ? site.result_domains : site.domains || [])
    .map((domain) => String(domain).replace(/^www\./i, '').toLowerCase());
  const repositorySearch = Boolean(site.repository_search);
  const repositoryFilters = githubRepositoryFilters(query);
  // Keep comma-bearing qualifier values such as `in:name,description,readme`
  // as one token. Splitting on commas leaks `description`/`readme` into the
  // relevance score and can make an unrelated card look like a hit.
  const terms = (String(query || '').replace(/(?<!\S)-?(?:site|in|language|stars|forks?|pushed|created|topic|user|org|repo|license|size|is|archived|mirror|sort):(?:"[^"]+"|[^\s]+)/gi, ' ').match(/"[^"]+"|[^\s]+/g) || [])
    .map((value) => value.replace(/^"|"$/g, '').trim())
    .filter((value) => value.length >= 1 && !SEARCH_QUALIFIER.test(value));
  const scopes = [...String(query || '').matchAll(/(?:^|\s)site:([^\s]+)/gi)]
    .map((match) => match[1].replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase())
    .filter(Boolean);
  // Site chrome (navigation, account, region switchers) is never a search result.
  const nav = /^(首页|主页|登录|注册|注册新用户|免费注册|退出|更多|更多>>|more|下一页|上一页|首页|尾页|末页|跳转|返回|关于我们|联系我们|帮助|帮助中心|网站地图|订阅|订阅信息|会员|vip|客服|下载|app|English|无障碍|关怀版|收藏|分享|打印|关闭|全部|政策法规|机构信息|新闻|资讯|通知|动态)$/i;
  const region = /^(北京|天津|上海|重庆|河北|山西|内蒙古|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|香港|澳门|台湾)(省|市|自治区)?$/;
  const notice = /公告|招标|采购|中标|成交|询价|比选|谈判|磋商|竞价|结果|变更|更正|项目|标段|合同|意向|预告|需求|废标|流标|终止/;
  const rows = content.links.flatMap((item, index) => {
    if (item.search_chrome && (repositorySearch || external)) return [];
    let url;
    try { url = decodedLink(item.url); } catch { return []; }
    const parsed = validateURL(url);
    if (!external && candidateDomains.length && !candidateDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return [];
    // A discovery index may intentionally link to another host (GitCN links
    // to GitHub). Its result_domains allow-list is stricter than the generic
    // external-search rule and prevents mirrors, downloads, or arbitrary
    // navigation pages from entering the candidate pool.
    if (external && (site.result_domains?.length || repositorySearch) && candidateDomains.length && !candidateDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return [];
    if (external && /(^|\.)(bing\.com|google\.com|sogou\.com|so\.com|baidu\.com|duckduckgo\.com|yahoo\.com|yandex\.com|search\.brave\.com|qwant\.com)$/.test(parsed.hostname)) return [];
    if (scopes.length && !scopes.some((scope) => parsed.hostname === scope || parsed.hostname.endsWith(`.${scope}`))) return [];
    if (pattern && !pattern.test(url)) return [];
    if (!repositorySearch && /\/(login|signin|signup|register|zhuce|privacy|terms|help|about)(?:[/?#.]|$)/i.test(parsed.pathname)) return [];
    if (parsed.pathname === '/' && !/^#!?\//.test(parsed.hash)) return [];
    if (repositorySearch && !repositoryURLAllowed(url, site)) return [];
    const key = canonicalURL(url);
    if (seen.has(key) || key === canonicalURL(content.requested_url)) return [];
    if (conflictsWithQuery(query, [item.text, item.title].filter(Boolean).join(' '))) return [];
    // Relevance: link text containing the query terms, notice-like titles and detail-like paths rank first.
    const text = [item.text, item.title, item.context].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (repositorySearch && !repositoryFilters.include_archived && /(?:\barchived\b|已归档|归档仓库)/i.test(text)) return [];
    if (repositorySearch && !repositoryFilters.include_forks && /(?:\bforked\b|is a fork|派生仓库)/i.test(text)) return [];
    const evidence = terms.map((term) => searchTermEvidence(term, text));
    const exactTerms = evidence.filter((item) => item.exact).map((item) => item.term);
    const softTerms = evidence.filter((item) => item.matched.length).map((item) => item.term);
    const hit = exactTerms.length;
    const contextEvidence = String(item.context || '').trim().length >= 20;
    if (repositorySearch && !contextEvidence) return [];
    const pathSignal = parsed.pathname.split('/').filter(Boolean).length >= 2 || /\d{4,}|detail|info|content|view|article|notice|bulletin|show|id=/i.test(parsed.pathname + parsed.search);
    let score = 0;
    if (hit) score += 10 + hit * 2;
    if (softTerms.length) score += Math.min(12, softTerms.length * 3);
    if (contextEvidence) score += 2;
    if (text.length >= 10 && notice.test(text)) score += 4;
    if (/\d{4,}|\.s?html?$|detail|info|content|view|article|notice|bulletin|show|id=/i.test(parsed.pathname + parsed.search)) score += 2;
    if (parsed.pathname.split('/').filter(Boolean).length >= 2) score += 1;
    if (text.length < 6) score -= 6;
    if (nav.test(text) || region.test(text)) score -= 10;
    // A result-card title may use nearby vocabulary for every query term.  A
    // real card with a deep target URL and at least two soft term matches is
    // useful enough to open and verify; a bare navigation link still fails.
    // Two independent query terms should both be visible in the result card;
    // accepting a single generic word is the common source of weak links.
    const minimumEvidence = terms.length >= 2 ? 2 : 1;
    const relevant = terms.length
      ? hit >= minimumEvidence || (contextEvidence && pathSignal && softTerms.length >= minimumEvidence)
      : score >= 6;
    // A detail pattern only says that the URL is structurally allowed. It is
    // not evidence that a link came from this search. When a query is
    // present, every source still needs the same relevance gate as external
    // search engines; otherwise GitHub navigation cards and popular-project
    // recommendations become false positives.
    // GitHub exposes many structurally valid navigation/recommendation links,
    // so it needs strict evidence. Other sites may render a real result as a
    // bare link with no accessible text; keep that unknown link for a later
    // detail-page check instead of claiming the search had no candidates.
    if (terms.length && !relevant && (repositorySearch || text)) return [];
    seen.add(key);
    const generic = genericResultLabel(item.text);
    const label = generic
      ? (item.title || (repositorySearch ? repositoryResultLabel(url) : '') || contextResultLabel(item.context) || item.text || '')
      : (item.text || item.title || contextResultLabel(item.context) || (repositorySearch ? repositoryResultLabel(url) : '') || '');
    return [{ item: { ...item, url, text: label, search_evidence: { exact_terms: exactTerms, soft_terms: softTerms, matched_variants: evidence.flatMap((row) => row.matched), context: contextEvidence, path_signal: pathSignal } }, score, index }];
  });
  return rows.sort((a, b) => b.score - a.score || a.index - b.index).map((row) => row.item);
}

export function publicSourceAlternate(url) {
  const parsed = validateURL(url);
  const video = parsed.pathname.match(/\/video\/(\d+)/)?.[1];
  if (parsed.hostname === 'jingxuan.douyin.com' && video) return `https://www.douyin.com/video/${video}`;
  if (parsed.hostname === 'apps.weibo.com' && /^\/\d+\/[a-z0-9]+$/i.test(parsed.pathname)) { parsed.hostname = 'weibo.com'; return parsed.href; }
  if (parsed.hostname === 'www.reddit.com' && /\/comments\//.test(parsed.pathname)) { parsed.hostname = 'old.reddit.com'; return parsed.href; }
  return null;
}

function socialSearchRoutes(site, queryPlan, original) {
  const routes = queryPlan.queries.map((item, index) => ({
    kind: index === 0 ? 'native' : 'native_variant',
    url: site.search?.replaceAll('{query}', encodeURIComponent(item.query)) || site.url,
    query: item.query,
    query_variant: item.query,
    purpose: item.purpose,
    search_platform: site.id,
  }));
  if (site.public_index && site.domains?.length) routes.push({
    kind: 'public_index',
    url: `https://www.bing.com/search?q=${encodeURIComponent(`site:${site.domains[0]} ${original}`)}`,
    query: original,
    query_variant: original,
    purpose: '公开索引备用路线',
    external_results: true,
    candidate_site: { ...site, result_domains: site.domains },
    search_platform: site.id,
  });
  return routes;
}

function socialRelatedTerms(candidates, original, platform) {
  const known = new Set(String(original || '').toLowerCase().split(/\s+/).filter(Boolean));
  const terms = [];
  const add = (value) => {
    const evidenceText = [value?.text, value?.title, value?.context].filter(Boolean).join(' ');
    for (const term of evidenceText.normalize('NFKC').match(/[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9+#.-]{2,}/gu) || []) {
      const key = term.toLowerCase();
      if (!known.has(key) && !terms.some((item) => item.term === term) && terms.length < 8) terms.push({ term, source_url: value?.url || null, evidence: value?.context || value?.text || '' });
    }
  };
  for (const candidate of candidates.slice(0, 12)) add(candidate);
  return terms.map((item) => ({ ...item, query: `${original} ${item.term}`, platform }));
}

// Runs inside the page (serialized by operations.evaluate), so it must stay self-contained.
// 搜索结果行：正文含关键词、可点击的行；index>=0 时点击该行，详情强制在当前标签页打开
function __lzRows({ query, index = -1 }) {
  const visible = (node) => {
    if (!node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const skip = (node) => node.closest('header,nav,footer,input,textarea,select,button,[class*="hot" i],[class*="recommend" i],[class*="tuijian" i],[class*="history" i],[class*="suggest" i],[class*="breadcrumb" i],[class*="filter" i],[class*="tag" i]');
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let textNode; (textNode = walker.nextNode());) {
    if (!textNode.textContent.includes(query)) continue;
    const element = textNode.parentElement;
    if (!element || !visible(element) || skip(element)) continue;
    const row = element.closest('a,[onclick],[role="row"],[role="link"],tr,li,[class*="item" i],[class*="card" i],[class*="title" i]') || element;
    const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length < 8 || text.length > 400 || rows.some((other) => other === row || other.contains(row) || row.contains(other))) continue;
    rows.push(row);
  }
  if (index < 0) return rows.length;
  const row = rows[index];
  if (!row) return null;
  for (const element of document.querySelectorAll('a[target],form[target]')) element.target = '_self';
  try {
    const script = document.createElement('script');
    script.textContent = 'window.open=function(u){u&&(location.href=u);return window};';
    document.documentElement.append(script);
    script.remove();
  } catch {}
  const target = [...row.querySelectorAll('*')].find((node) => !node.children.length && (node.textContent || '').includes(query)) || row;
  target.scrollIntoView({ block: 'center' });
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 结果行没有链接地址时，逐条点击取得详情地址
async function __lzHarvest(operations, listURL, query, limit) {
  const out = [];
  const seen = new Set([listURL]);
  for (let i = 0; i < limit + 3 && out.length < limit; i++) {
    try {
      await operations.navigate(listURL);
      const ready = await operations.policy.waitUntil(listURL, () => operations.evaluate(__lzRows, { query }), (value) => value > i, { timeout_ms: 12000 });
      if (!ready.satisfied) break;
      const before = await operations.evaluate(() => location.href);
      const text = await operations.evaluate(__lzRows, { query, index: i }, { idempotent: false, label: 'open_result_row' });
      if (!text) break;
      const moved = await operations.policy.waitUntil(listURL, () => operations.evaluate(() => location.href), (value) => Boolean(value) && value !== before && /^https?:/.test(value), { timeout_ms: 8000 });
      const url = moved.last;
      if (moved.satisfied && url && !seen.has(url)) {
        seen.add(url);
        out.push({ url, text, title: text, via: 'click' });
      }
    } catch {
      break;
    }
  }
  return out;
}

export async function search(page, kwargs, sharedOperations, capturePage = capture) {
  const count = Number(kwargs.read || 0);
  if (!Number.isInteger(count) || count < 0 || count > 20) throw new Error('--read must be 0-20.');
  if (!kwargs.query?.trim()) throw new Error('A non-empty search query is required.');
  const out = kwargs.out || DEFAULT_OUTPUT;
  const searchArchive = (await findTaskArchive(out))?.folder || await createTaskArchive(out, `${kwargs.platform || 'web'}_${kwargs.query}`);
  let operations;
  let queryPlan;
  let activeURL;
  const attempts = [];
  let candidates = [], sources = [];
  let result;
  try {
    operations = sharedOperations || await createBrowserOperations(page, kwargs);
    const report = (patch = {}) => Promise.resolve(operations.reportProgress?.(patch)).catch(() => null);
    const site = await resolveSite(kwargs.platform, kwargs.query, kwargs.site);
    const query = site.query;
    const githubPlan = site.id === 'github';
    const socialPlan = ['xhs', 'douyin'].includes(site.id);
    queryPlan = githubPlan ? githubQueryPlan(kwargs.query, { preferredKeywords: site.preferred_keywords }) : socialPlan ? expandSocialQueries(kwargs.query, { platform: site.id, maxQueries: 8 }) : null;
    await report({ stage: 'planning', platform: site.id, query: kwargs.query, query_count: 0, candidate_count: 0, verified_count: 0, comment_loaded: 0 });
    const routes = githubPlan
      ? githubSearchRoutes(site, kwargs.query, queryPlan)
      : socialPlan
        ? socialSearchRoutes(site, queryPlan, kwargs.query)
      : [{ kind: 'native', url: site.search?.replaceAll('{query}', encodeURIComponent(query)) || site.url, query, form: site.mode ? { mode: site.mode, parameter: site.parameter, entry_url: site.form_url, query_parameter: site.query_parameter } : undefined }];
    if (!githubPlan && !socialPlan) {
      for (const url of site.alternates || []) routes.push({ kind: 'public_alternate', url: url.replaceAll('{query}', encodeURIComponent(query)), query });
      if (site.public_index && !['procurement', 'company', 'commerce', 'analytics', 'creator', 'custom'].includes(site.category)) routes.push({ kind: 'public_index', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:${site.index_domain || site.domains[0]} ${kwargs.query}`)}`, query: kwargs.query });
      if (site.preferred_route && site.preferred_route !== 'public_index') routes.sort((a, b) => Number(b.kind === site.preferred_route) - Number(a.kind === site.preferred_route));
    }
    const candidateMap = new Map();
    const mergeCandidates = (found, route) => {
      if (!queryPlan) { candidates = found; return; }
      const ranked = githubPlan ? rankGitHubCandidates(found, queryPlan) : found;
      for (const item of ranked) {
        const key = canonicalURL(item.url);
        const previous = candidateMap.get(key);
        const variants = [...new Set([...(previous?.query_variants || previous?.github_query_variants || []), route.query_variant || 'primary'])];
        const chosen = !previous || (githubPlan && item.github_score > previous.github_score) ? item : previous || item;
        candidateMap.set(key, { ...chosen, query_variant: chosen.query_variant || route.query_variant || 'primary', query_variants: variants, ...(githubPlan ? { github_query_variants: variants } : {}) });
      }
      const all = [...candidateMap.values()];
      const relevant = githubPlan ? all.filter((item) => item.github_score > 0) : all;
      candidates = (relevant.length ? relevant : all).sort((a, b) => (githubPlan ? (b.github_score - a.github_score) : ((b.search_evidence?.exact_terms?.length || 0) - (a.search_evidence?.exact_terms?.length || 0))) || String(a.url).localeCompare(String(b.url)));
    };
    let discovery;
    let nativeGate;
    const queryCandidateTarget = queryPlan ? (githubPlan ? Math.max(5, count) : Math.max(3, count * 2)) : 0;
    // Search pages need only enough scrolling to expose their first result
    // cards. Reusing the full article budget for every GitHub query variant
    // exhausts the shared operation window before source details can be
    // checked. Keep discovery bounded and reserve a larger budget for the
    // few repository pages opened with --read; search evidence remains in the
    // saved HTML/JSON, so screenshots are deferred for a standalone capture.
    const discoveryScrolls = site.repository_search || queryPlan
      ? Math.min(Math.max(0, Number(kwargs.scrolls ?? 12)), 1)
      : kwargs.scrolls;
    const detailScrolls = queryPlan
      ? Math.min(Math.max(0, Number(kwargs.scrolls ?? 12)), 8)
      : kwargs.scrolls;
    let nativeUnavailable = false;
    for (const route of routes.slice(0, queryPlan ? 7 : 3)) {
      const nativeRoute = route.kind.startsWith('native');
      // GitCN is a last-resort discovery index. Once a native GitHub route
      // has produced a candidate, do not spend another browser operation on
      // the mirror; if native pages are unavailable or empty, it remains a
      // bounded fallback after the public-index routes.
      if (githubPlan && route.kind === 'mirror' && candidates.length) continue;
      if ((githubPlan || socialPlan) && nativeUnavailable && nativeRoute) continue;
      console.error(`[LuzCrawl] ${site.name}: ${route.kind} browser search`);
      let current;
      const routeQuery = route.query || query;
      activeURL = route.url;
      await report({ stage: 'query', platform: site.id, query_current: routeQuery, query_count: attempts.length + 1, candidate_count: candidates.length, verified_count: sources.filter((item) => item.url_check?.valid_content === true).length });
      try { current = await capturePage(page, { ...kwargs, scrolls: discoveryScrolls, screenshot: site.repository_search || queryPlan ? false : kwargs.screenshot, out: searchArchive, resume: true, url: route.url, query: routeQuery, search_platform: route.search_platform || site.id, search_form: route.form }, operations); }
      catch (error) {
        const failure = classifyFailure(error);
        if ((githubPlan || socialPlan) && nativeRoute && ['unavailable', 'transient_failure'].includes(failure.code)) nativeUnavailable = true;
        attempts.push({ route_kind: route.kind, query_variant: route.query_variant, route_query: routeQuery, url: sourceURL(route.url), status: 'failed', error: failure.message, stop_reason: failure.code, failure: failure.toJSON(), search_performed: false, candidates: 0 });
        if (DISCOVERY_STOPS.has(failure.code)) throw failure;
        continue;
      }
      const content = JSON.parse(await fs.readFile(path.join(current.folder, 'raw/content.json'), 'utf8'));
      const performed = Boolean(current.search_action?.submitted && current.search_action?.effect_verified !== false);
      const needsAccount = site.account && !performed && current.search_action?.login_visible;
      const gate = ['login_required', 'verification_required'].includes(current.stop_reason) ? current.stop_reason : needsAccount ? 'login_required' : null;
      if ((githubPlan || socialPlan) && nativeRoute && ['unavailable', 'transient_failure'].includes(current.stop_reason)) nativeUnavailable = true;
      if (gate && (nativeRoute || gate === 'verification_required')) nativeGate ||= { reason: gate, url: route.url };
      const candidateSite = route.candidate_site ? { ...site, ...route.candidate_site } : site;
      const externalResults = route.external_results ?? (candidateSite.result_domains?.length ? true : candidateSite.external_results && !kwargs.site);
      const candidateQuery = queryPlan ? `${routeQuery} ${(queryPlan.qualifiers || []).join(' ')}`.trim() : routeQuery;
      let found = performed && !gate && current.url_check?.valid_content ? sourceCandidates(content, candidateSite, externalResults, candidateQuery) : [];
      if (route.filters_require_detail_check) found = found.map(item => ({ ...item, filters_require_detail_check: route.filters_require_detail_check }));
      // Result rows without link addresses: open each row once to learn its detail URL.
      if (!found.length && !queryPlan && !candidateSite.repository_search && !externalResults && !route.kind.startsWith('public_index') && performed && !gate && current.url_check?.valid_content && String(content.text || '').includes(routeQuery)) {
        try {
          const harvested = await __lzHarvest(operations, current.resolved_url, routeQuery, Math.max(count, 3));
          found = harvested.filter((item) => !candidateSite.repository_search || repositoryURLAllowed(item.url, candidateSite));
        } catch {}
      }
      mergeCandidates(found, route);
      // A readable page with zero usable links is a search miss, even when
      // the page capture itself reached a stable state. Conversely, a card
      // found before the scroll budget expires is a useful route observation.
      const routeStatus = gate ? 'awaiting_user' : found.length
        ? (['captured', 'scroll_budget'].includes(current.status) || current.stop_reason === 'scroll_budget' ? 'captured' : current.status)
        : current.status === 'captured' ? 'partial' : current.status;
      const outcome = gate || (DISCOVERY_STOPS.has(current.stop_reason) ? current.stop_reason : !performed ? 'search_not_confirmed' : found.length ? 'candidates_found' : current.url_check?.valid_content ? 'no_candidates' : current.stop_reason || 'invalid_content');
      attempts.push({ route_kind: route.kind, query_variant: route.query_variant, route_query: routeQuery, purpose: route.purpose, filters_require_detail_check: route.filters_require_detail_check, source_platform: route.candidate_site?.id || site.id, url: sourceURL(route.url), resolved_url: current.resolved_url, url_check: current.url_check, search_performed: performed, outcome, status: routeStatus, capture_status: current.status, gate, candidates: found.length, merged_candidates: candidates.length, folder: current.folder, html_file: current.html_file, stop_reason: current.stop_reason });
      await report({ stage: 'candidates', query_current: routeQuery, query_count: attempts.filter((item) => item.search_performed).length, candidate_count: candidates.length, verified_count: sources.filter((item) => item.url_check?.valid_content === true).length, stop_reason: current.stop_reason });
      await recordExperience({ platform: site.id, extractor_version: VERSION, canonical_url: canonicalURL(route.url), query: kwargs.query, route_query: routeQuery, status: routeStatus, stop_reason: gate || (!found.length && current.status === 'captured' ? 'no_candidates' : current.stop_reason), route_kind: route.kind, search_performed: performed, valid_content: Boolean(current.url_check?.valid_content), resolved_url: current.resolved_url, candidates: found.length, lesson: [...(current.limitations || []), ...(!found.length ? ['搜索页可读但没有通过候选相关性筛选的结果'] : [])].join('; ') });
      if (!discovery || found.length > (discovery.candidates || 0)) discovery = { ...current, search_url: sourceURL(route.url), route_kind: route.kind, query_variant: route.query_variant, candidates: found.length };
      if (DISCOVERY_STOPS.has(current.stop_reason)) break;
      if (found.length && !queryPlan) break;
      if (queryPlan && candidates.length >= queryCandidateTarget) break;
    }
    if (!discovery) {
      result = { status: 'failed', platform: site.id, query: kwargs.query, attempts, search_performed: false, query_plan: queryPlan || undefined, search_queries: queryPlan?.queries || undefined, error: attempts.at(-1)?.error || 'All browser routes failed.' };
    } else {
      const relatedTerms = socialPlan ? socialRelatedTerms(candidates, kwargs.query, site.id) : [];
      let awaiting;
      // A high-ranked result can be deleted, geo-blocked, or temporarily
      // unreachable while the next result is readable. Try a small bounded
      // cushion so one bad link cannot turn a useful search into a failure.
      const discoveryStop = attempts.find(item => DISCOVERY_STOPS.has(item.stop_reason));
      const adaptiveBudget = socialPlan ? selectAdaptiveBudget({ candidates: candidates.length, read: count, comments: Boolean(kwargs.comments), base: Math.max(3, count), failures: 0, hardMax: Math.max(20, count * 4) }) : null;
      const detailAttemptLimit = discoveryStop || count === 0 ? 0 : queryPlan
        ? Math.min(candidates.length, socialPlan ? adaptiveBudget.detail_limit : Math.max(count, count + 3))
        : Math.min(candidates.length, count);
      for (const [index, link] of candidates.entries()) {
        if (sources.filter((item) => item.status === 'captured' && item.url_check?.valid_content === true).length >= count) break;
        if (index >= detailAttemptLimit) break;
        await report({ stage: kwargs.comments ? 'comments' : 'detail', candidate_count: candidates.length, verified_count: sources.filter((item) => item.url_check?.valid_content === true).length, query_count: attempts.filter((item) => item.search_performed).length });
        let currentPage = false;
        if (site.id === 'xhs' && discovery.route_kind === 'native') {
          await operations.navigate(discovery.search_url);
          const ready = await operations.policy.waitUntil(operations.url,
            () => operations.evaluate(clickSearchResult, { url: link.url, inspect: true }), value => Boolean(value), { timeout_ms: 5000 });
          if (ready.satisfied) currentPage = await operations.evaluate(clickSearchResult, { url: link.url }, { idempotent: false, label: 'open_search_result_once' });
        }
        const alternate = publicSourceAlternate(link.url);
        const learned = alternate && site.source_corrections.some((event) => event.source_host === new URL(link.url).hostname && event.verified_host === new URL(alternate).hostname);
        activeURL = learned ? alternate : link.url;
        let source = await capturePage(page, { ...kwargs, scrolls: detailScrolls, screenshot: queryPlan ? false : kwargs.screenshot, out: searchArchive, resume: true, query: '', search_form: undefined, current_page: currentPage, url: learned ? alternate : link.url }, operations);
        if (alternate && !learned && !source.url_check?.valid_content && !['verification_required', 'rate_limited', 'operation_budget', 'cancelled'].includes(source.stop_reason) && (source.stop_reason !== 'login_required' || new URL(link.url).hostname === 'apps.weibo.com')) {
          const original = source;
          activeURL = alternate;
          source = await capturePage(page, { ...kwargs, scrolls: detailScrolls, screenshot: queryPlan ? false : kwargs.screenshot, out: searchArchive, resume: true, query: '', search_form: undefined, url: alternate }, operations);
          source.url_correction = { original: sourceURL(link.url), alternate, original_status: original.status, original_reason: original.stop_reason, validated: Boolean(source.url_check?.valid_content) };
          await recordExperience({ platform: site.id, extractor_version: VERSION, canonical_url: canonicalURL(link.url), status: source.status, stop_reason: source.stop_reason, route_kind: 'source_url_correction', source_host: new URL(link.url).hostname, verified_host: new URL(alternate).hostname, validated_url: source.url_check?.valid_content ? source.resolved_url : undefined, lesson: `${source.url_check?.valid_content ? 'Verified' : 'Unverified'} public page for the same content ID: ${sourceURL(alternate)}` });
        }
        sources.push({ url: sourceURL(link.url), query_variant: link.query_variant || link.query_variants?.[0] || 'primary', ...source, attempt_status: source.status, stop_reason: source.stop_reason || undefined, url_check: source.url_check });
        await report({ stage: kwargs.comments ? 'comments' : 'detail', candidate_count: candidates.length, verified_count: sources.filter((item) => item.url_check?.valid_content === true).length, comment_loaded: sources.reduce((sum, item) => sum + (item.comments_coverage?.loaded ?? item.comments?.length ?? 0), 0), stop_reason: source.stop_reason });
        if (['rate_limited', 'operation_budget', 'cancelled'].includes(source.stop_reason)) break;
        if (['login_required', 'verification_required'].includes(source.stop_reason)) { awaiting = { reason: source.stop_reason, url: source.url_correction?.alternate || link.url }; break; }
      }
      if (!awaiting && nativeGate && (!candidates.length || count > 0 && !sources.some(source => source.url_check?.valid_content)) && !['rate_limited', 'operation_budget', 'cancelled', 'access_denied'].includes(discoveryStop?.stop_reason)) { awaiting = nativeGate; if (!discoveryStop) await operations.navigate(nativeGate.url); }
      const hardStop = Boolean(discoveryStop);
      const verifiedSources = sources.filter((item) => item.status === 'captured' && item.url_check?.valid_content === true);
      const detailsComplete = count === 0 || verifiedSources.length >= count;
      const usefulSearch = candidates.length > 0 && detailsComplete && !hardStop;
      result = { ...discovery, ...(discoveryStop ? { stop_reason: discoveryStop.stop_reason } : {}), platform: site.id, platform_name: site.name, query: kwargs.query, scope: 'search_candidates_and_opened_sources', search_performed: attempts.some((item) => item.search_performed), search_status: candidates.length ? 'candidates_found' : awaiting ? 'awaiting_user' : 'no_verified_candidates', discovery_status: discovery.status, status: awaiting ? 'awaiting_user' : usefulSearch ? 'captured' : 'partial', attempts, discovered_candidates: candidates.length, candidates: candidates.slice(0, 100), requested_sources: count, opened_sources: sources.length, verified_sources: verifiedSources.length, detail_attempt_limit: detailAttemptLimit, adaptive_budget: adaptiveBudget || undefined, sources, query_plan: queryPlan || undefined, search_queries: queryPlan?.queries || undefined, suggested_queries: queryPlan?.suggested_queries || site.suggested_queries, related_terms: relatedTerms, preferred_keywords: site.preferred_keywords, access_mode: kwargs.access_mode === 'authorized_browser' ? 'authorized_browser' : 'public', ...(awaiting ? { requires_user: true, awaiting_reason: awaiting.reason, handover_url: sourceURL(awaiting.url) } : {}) };
    }
  } catch (error) {
    const failure = classifyFailure(error);
    const awaiting = ['login_required', 'verification_required'].includes(failure.code);
    result = { status: awaiting ? 'awaiting_user' : candidates.length || sources.length ? 'partial' : 'failed', platform: kwargs.platform, query: kwargs.query, search_performed: attempts.some((item) => item.search_performed), search_status: awaiting ? 'awaiting_user' : candidates.length ? 'candidates_found' : 'no_verified_candidates', attempts, discovered_candidates: candidates.length, candidates, opened_sources: sources.length, verified_sources: sources.filter(item => item.status === 'captured' && item.url_check?.valid_content === true).length, sources, query_plan: queryPlan || undefined, search_queries: queryPlan?.queries || undefined, related_terms: [], adaptive_budget: queryPlan ? selectAdaptiveBudget({ candidates: candidates.length, read: count, comments: Boolean(kwargs.comments), base: Math.max(3, count), failures: 0, hardMax: Math.max(20, count * 4) }) : undefined, access_mode: kwargs.access_mode === 'authorized_browser' ? 'authorized_browser' : 'public', stop_reason: failure.code, failure: failure.toJSON(), error: failure.message, ...(awaiting ? { requires_user: true, awaiting_reason: failure.code, handover_url: activeURL ? sourceURL(activeURL) : undefined } : {}) };
    await operations?.reportProgress?.({ stage: 'stopped', query_count: attempts.filter((item) => item.search_performed).length, candidate_count: candidates.length, verified_count: result.verified_sources, stop_reason: failure.code });
  }
  const indexFile = path.join(searchArchive, `search-${Date.now()}-${randomUUID()}.json`);
  const saved = { ...result, search_archive: searchArchive, search_index: indexFile };
  await atomicWrite(indexFile, saved);
  return { ...saved, ...(operations ? { execution: operations.summary() } : {}) };
}
