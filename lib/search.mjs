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

export function sourceCandidates(content, site, external = false, query = '') {
  const seen = new Set();
  const pattern = site.detail ? new RegExp(site.detail, 'i') : null;
  const terms = String(query || '').split(/[\s,，、]+/).map((value) => value.trim()).filter((value) => value.length >= 1);
  // Site chrome (navigation, account, region switchers) is never a search result.
  const nav = /^(首页|主页|登录|注册|注册新用户|免费注册|退出|更多|更多>>|more|下一页|上一页|首页|尾页|末页|跳转|返回|关于我们|联系我们|帮助|帮助中心|网站地图|订阅|订阅信息|会员|vip|客服|下载|app|English|无障碍|关怀版|收藏|分享|打印|关闭|全部|政策法规|机构信息|新闻|资讯|通知|动态)$/i;
  const region = /^(北京|天津|上海|重庆|河北|山西|内蒙古|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|香港|澳门|台湾)(省|市|自治区)?$/;
  const notice = /公告|招标|采购|中标|成交|询价|比选|谈判|磋商|竞价|结果|变更|更正|项目|标段|合同|意向|预告|需求|废标|流标|终止/;
  const rows = content.links.flatMap((item, index) => {
    let url;
    try { url = decodedLink(item.url); } catch { return []; }
    const parsed = validateURL(url);
    if (!external && !site.domains.map((domain) => domain.replace(/^www\./, '')).some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return [];
    if (external && /(^|\.)(bing\.com|google\.com|sogou\.com|so\.com|duckduckgo\.com)$/.test(parsed.hostname)) return [];
    if (pattern && !pattern.test(url)) return [];
    if (/\/(login|signin|signup|register|zhuce|privacy|terms|help|about)(?:[/?#.]|$)/i.test(parsed.pathname)) return [];
    if (parsed.pathname === '/' && !/^#!?\//.test(parsed.hash)) return [];
    const key = canonicalURL(url);
    if (seen.has(key) || key === canonicalURL(content.requested_url)) return [];
    // Relevance: link text containing the query terms, notice-like titles and detail-like paths rank first.
    const text = String(item.text || item.title || '').replace(/\s+/g, ' ').trim();
    const hit = terms.filter((term) => text.toLowerCase().includes(term.toLowerCase())).length;
    let score = 0;
    if (hit) score += 10 + hit * 2;
    if (text.length >= 10 && notice.test(text)) score += 4;
    if (/\d{4,}|\.s?html?$|detail|info|content|view|article|notice|bulletin|show|id=/i.test(parsed.pathname + parsed.search)) score += 2;
    if (parsed.pathname.split('/').filter(Boolean).length >= 2) score += 1;
    if (text.length < 6) score -= 6;
    if (nav.test(text) || region.test(text)) score -= 10;
    if (!pattern && (terms.length ? !hit : score < 6)) return [];
    seen.add(key);
    return [{ item: { ...item, url }, score, index }];
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
  const attempts = [];
  let candidates = [], sources = [];
  let result;
  try {
    operations = sharedOperations || await createBrowserOperations(page, kwargs);
    const site = await resolveSite(kwargs.platform, kwargs.query, kwargs.site);
    const query = site.query;
    const routes = [{ kind: 'native', url: site.search?.replaceAll('{query}', encodeURIComponent(query)) || site.url, form: site.mode ? { mode: site.mode, parameter: site.parameter, entry_url: site.form_url } : undefined }];
    for (const url of site.alternates || []) routes.push({ kind: 'public_alternate', url: url.replaceAll('{query}', encodeURIComponent(query)) });
    if (site.public_index && !['procurement', 'company', 'commerce', 'analytics', 'creator', 'custom'].includes(site.category)) routes.push({ kind: 'public_index', url: `https://www.bing.com/search?q=${encodeURIComponent(`site:${site.index_domain || site.domains[0]} ${kwargs.query}`)}` });
    if (site.preferred_route && site.preferred_route !== 'public_index') routes.sort((a, b) => Number(b.kind === site.preferred_route) - Number(a.kind === site.preferred_route));
    let discovery;
    let nativeGate;
    for (const route of routes.slice(0, 3)) {
      console.error(`[LuzCrawl] ${site.name}: ${route.kind} browser search`);
      let current;
      try { current = await capturePage(page, { ...kwargs, out: searchArchive, resume: true, url: route.url, query, search_platform: site.id, search_form: route.form }, operations); }
      catch (error) { attempts.push({ route_kind: route.kind, url: sourceURL(route.url), status: 'failed', error: error.message, search_performed: false, candidates: 0 }); continue; }
      const content = JSON.parse(await fs.readFile(path.join(current.folder, 'raw/content.json'), 'utf8'));
      const performed = Boolean(current.search_action?.submitted);
      const needsAccount = site.account && !performed && current.search_action?.login_visible;
      const gate = ['login_required', 'verification_required'].includes(current.stop_reason) ? current.stop_reason : needsAccount ? 'login_required' : null;
      if (route.kind !== 'public_index' && gate) nativeGate ||= { reason: gate, url: route.url };
      let found = performed && !gate && current.url_check?.valid_content ? sourceCandidates(content, site, site.external_results && !kwargs.site, kwargs.query) : [];
      // Result rows without link addresses: open each row once to learn its detail URL.
      if (!found.length && performed && !gate && current.url_check?.valid_content && String(content.text || '').includes(query)) {
        try { found = await __lzHarvest(operations, current.resolved_url, query, Math.max(count, 3)); } catch {}
      }
      attempts.push({ route_kind: route.kind, url: sourceURL(route.url), resolved_url: current.resolved_url, url_check: current.url_check, search_performed: performed, status: current.status, gate, candidates: found.length, folder: current.folder, html_file: current.html_file, stop_reason: current.stop_reason });
      await recordExperience({ platform: site.id, extractor_version: VERSION, canonical_url: canonicalURL(route.url), query: kwargs.query, status: gate ? 'awaiting_user' : current.status, stop_reason: gate || current.stop_reason, route_kind: route.kind, search_performed: performed, valid_content: Boolean(current.url_check?.valid_content), resolved_url: current.resolved_url, candidates: found.length, lesson: current.limitations.join('; ') });
      discovery = { ...current, search_url: sourceURL(route.url), route_kind: route.kind };
      if (['rate_limited', 'operation_budget', 'cancelled'].includes(current.stop_reason)) break;
      if (found.length) { candidates = found; break; }
    }
    if (!discovery) {
      result = { status: 'failed', platform: site.id, query: kwargs.query, attempts, search_performed: false, error: attempts.at(-1)?.error || 'All browser routes failed.' };
    } else {
      let awaiting;
      for (const [index, link] of candidates.slice(0, count).entries()) {
        let currentPage = false;
        if (site.id === 'xhs' && discovery.route_kind === 'native') {
          await operations.navigate(discovery.search_url);
          const ready = await operations.policy.waitUntil(operations.url,
            () => operations.evaluate(clickSearchResult, { url: link.url, inspect: true }), value => Boolean(value), { timeout_ms: 5000 });
          if (ready.satisfied) currentPage = await operations.evaluate(clickSearchResult, { url: link.url }, { idempotent: false, label: 'open_search_result_once' });
        }
        const alternate = publicSourceAlternate(link.url);
        const learned = alternate && site.source_corrections.some((event) => event.source_host === new URL(link.url).hostname && event.verified_host === new URL(alternate).hostname);
        let source = await capturePage(page, { ...kwargs, out: searchArchive, resume: true, query: '', search_form: undefined, current_page: currentPage, url: learned ? alternate : link.url }, operations);
        if (alternate && !learned && !source.url_check?.valid_content && !['verification_required', 'rate_limited', 'operation_budget', 'cancelled'].includes(source.stop_reason) && (source.stop_reason !== 'login_required' || new URL(link.url).hostname === 'apps.weibo.com')) {
          const original = source;
          source = await capturePage(page, { ...kwargs, out: searchArchive, resume: true, query: '', search_form: undefined, url: alternate }, operations);
          source.url_correction = { original: sourceURL(link.url), alternate, original_status: original.status, original_reason: original.stop_reason, validated: Boolean(source.url_check?.valid_content) };
          await recordExperience({ platform: site.id, extractor_version: VERSION, canonical_url: canonicalURL(link.url), status: source.status, stop_reason: source.stop_reason, route_kind: 'source_url_correction', source_host: new URL(link.url).hostname, verified_host: new URL(alternate).hostname, validated_url: source.url_check?.valid_content ? source.resolved_url : undefined, lesson: `${source.url_check?.valid_content ? 'Verified' : 'Unverified'} public page for the same content ID: ${sourceURL(alternate)}` });
        }
        sources.push({ url: sourceURL(link.url), ...source });
        if (['rate_limited', 'operation_budget', 'cancelled'].includes(source.stop_reason)) break;
        if (['login_required', 'verification_required'].includes(source.stop_reason)) { awaiting = { reason: source.stop_reason, url: source.url_correction?.alternate || link.url }; break; }
      }
      if (!awaiting && nativeGate && (!candidates.length || count > 0 && !sources.some(source => source.url_check?.valid_content)) && !['rate_limited', 'operation_budget', 'cancelled'].includes(discovery.stop_reason)) { awaiting = nativeGate; await operations.navigate(nativeGate.url); }
      result = { ...discovery, platform: site.id, platform_name: site.name, query: kwargs.query, scope: 'search_candidates_and_opened_sources', search_performed: attempts.some((item) => item.search_performed), search_status: candidates.length ? 'candidates_found' : awaiting ? 'awaiting_user' : 'no_verified_candidates', discovery_status: discovery.status, status: awaiting ? 'awaiting_user' : !candidates.length || sources.length < count || sources.some((item) => item.status !== 'captured') ? 'partial' : discovery.status, attempts, discovered_candidates: candidates.length, candidates: candidates.slice(0, 100), requested_sources: count, opened_sources: sources.length, verified_sources: sources.filter((item) => item.status === 'captured').length, sources, suggested_queries: site.suggested_queries, preferred_keywords: site.preferred_keywords, ...(awaiting ? { requires_user: true, awaiting_reason: awaiting.reason, handover_url: sourceURL(awaiting.url) } : {}) };
    }
  } catch (error) {
    const failure = classifyFailure(error);
    result = { status: candidates.length || sources.length ? 'partial' : 'failed', platform: kwargs.platform, query: kwargs.query, search_performed: attempts.some((item) => item.search_performed), search_status: candidates.length ? 'candidates_found' : 'no_verified_candidates', attempts, discovered_candidates: candidates.length, candidates, opened_sources: sources.length, verified_sources: sources.filter(item => item.status === 'captured').length, sources, stop_reason: failure.code, failure: failure.toJSON(), error: failure.message };
  }
  const indexFile = path.join(searchArchive, `search-${Date.now()}-${randomUUID()}.json`);
  const saved = { ...result, search_archive: searchArchive, search_index: indexFile };
  await atomicWrite(indexFile, saved);
  return { ...saved, ...(operations ? { execution: operations.summary() } : {}) };
}
