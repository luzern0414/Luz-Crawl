import { OperationError } from './failure.mjs';

// Repairs URLs typed or pasted by people: stray quotes and brackets, full-width punctuation,
// misspelled schemes (htps:, hxxp:, ttp;//) and bare domains.
export function lzFixURL(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^[<"'“‘（(【\[《]+/, '')
    .replace(/[>"'”’】\]》。，、；;,!！?？]+$/, '');
  while (/[)）]$/.test(s) && (s.match(/[(（]/g) || []).length < (s.match(/[)）]/g) || []).length) s = s.slice(0, -1);
  const scheme = s.match(/^([a-z]{2,7})[:;]?\/{0,3}/i);
  if (scheme && !/^https?:\/\//i.test(s) && /^(h?t{1,3}p{1,2}s?|hxxps?)$/i.test(scheme[1])) {
    s = (/s$/i.test(scheme[1]) ? 'https://' : 'http://') + s.slice(scheme[0].length);
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+([.。][\w-]+)+(:\d+)?([/?#]|$)/.test(s)) {
    s = 'https://' + s;
  }
  s = s.replace(/^(https?:\/\/[^/?#]*)/i, (host) => host.replace(/。/g, '.').toLowerCase());
  if (s !== raw.trim()) console.error(`[luz-crawl] 网址已纠正：${raw.trim()} → ${s}`);
  return s;
}

// Fallback addresses for a page that did not load: the other scheme, then with or without www.
export function lzVariants(raw) {
  const out = [];
  try {
    const url = new URL(raw);
    const add = (value) => {
      if (value !== url.href && !out.includes(value)) out.push(value);
    };
    const alt = new URL(url.href);
    alt.protocol = url.protocol === 'https:' ? 'http:' : 'https:';
    add(alt.href);
    const www = new URL(url.href);
    www.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : 'www.' + url.hostname;
    add(www.href);
  } catch {}
  return out.slice(0, 3);
}

// Returns the page the browser actually landed on; when it stopped on a browser error page
// (chrome-error://, about:blank, ...) tries the fallback addresses before failing.
export async function lzLanded(operations, url, current) {
  let href = await operations.evaluate('location.href');
  if (/^https?:/i.test(href) || current) return href;
  const first = String(href).split('/')[0] || 'about:blank';
  const tried = [];
  for (const next of lzVariants(url)) {
    tried.push(next);
    await new Promise((resolve) => setTimeout(resolve, 1200 * tried.length));
    try {
      await operations.navigate(next);
    } catch {}
    href = await operations.evaluate('location.href');
    if (/^https?:/i.test(href)) {
      console.error(`[luz-crawl] 原网址打不开，改用 ${next}`);
      return href;
    }
  }
  throw new OperationError(
    'unavailable',
    `网站在当前网络下打不开（浏览器停在 ${first} 错误页）。已尝试：${[url, ...tried].join('、')}。可能原因：网址拼写错误、网站受网络限制或需要代理（可设置 HTTPS_PROXY 后重试）、证书或安全拦截；可换同一内容的其他公开入口。`,
  );
}

export function validateURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) page URLs without embedded credentials are supported.');
  }
  return url;
}

export function platformOf(value) {
  const host = validateURL(value).hostname.toLowerCase();
  const matches = (domain) => host === domain || host.endsWith(`.${domain}`);
  const domains = CATALOG.flatMap((site) => site.domains.map((domain) => ({ domain, id: site.id }))).sort((a, b) => b.domain.length - a.domain.length);
  for (const entry of domains) if (matches(entry.domain)) return entry.id;
  return 'web';
}

export function sourceURL(value) {
  const url = validateURL(value);
  // SPA paths identify analytics dashboards; ordinary in-page anchors do not.
  if (!/^#!?\//.test(url.hash)) url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|auth|authorization|access_token|refresh_token|api_key|session|sessionid|password|code)$/i.test(key)) url.searchParams.delete(key);
  }
  if (/^#!?\//.test(url.hash) && url.hash.includes('?')) {
    const prefix = url.hash.startsWith('#!') ? '#!' : '#';
    const fragment = new URL(url.hash.slice(prefix.length), url.origin);
    for (const key of [...fragment.searchParams.keys()]) if (/^(auth|authorization|access_token|refresh_token|api_key|session|sessionid|password|code)$/i.test(key)) fragment.searchParams.delete(key);
    url.hash = prefix + fragment.pathname + fragment.search;
  }
  return url.href;
}

export function canonicalURL(value) {
  const url = new URL(sourceURL(value));
  const platform = platformOf(url.href);
  if (platform === 'x') {
    const id = url.pathname.match(/\/(?:status|article)\/(\d+)/);
    if (id) return `https://x.com/i/${id[0].includes('/article/') ? 'article' : 'status'}/${id[1]}`;
  }
  if (platform === 'xhs') {
    const id = url.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([a-f\d]+)/i);
    if (id) return `https://www.xiaohongshu.com/explore/${id[1]}`;
  }
  if (platform === 'youtube') {
    const id = url.searchParams.get('v') || (url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1]);
    if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }
  if (platform === 'douyin') {
    const id = url.pathname.match(/\/(video|note)\/(\d+)/);
    if (id) return `https://www.douyin.com/${id[1]}/${id[2]}`;
  }
  for (const key of ['xsec_token', 'xsec_source', 'share', 'feature', 'si', 'source', 'ref', 'ref_src']) url.searchParams.delete(key);
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}

export function searchURL(platform, query, site) {
  if (!query?.trim()) throw new Error('A non-empty search query is required.');
  const entry = CATALOG.find((item) => item.id === platform || item.aliases?.includes(platform));
  if (!entry) throw new Error(`Unknown platform: ${platform}. Register a website with remember, or capture its URL.`);
  return entry.search?.replaceAll('{query}', encodeURIComponent(site ? `site:${site} ${query.trim()}` : query.trim())) || entry.url;
}

export function decodedLink(value) {
  const url = validateURL(value);
  let target;
  if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u');
    if (encoded?.startsWith('a1')) target = Buffer.from(encoded.slice(2), 'base64url').toString('utf8');
  }
  if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url') target = url.searchParams.get('q') || url.searchParams.get('url');
  if (/(^|\.)duckduckgo\.com$/.test(url.hostname)) target = url.searchParams.get('uddg');
  try { return target ? validateURL(target).href : url.href; } catch { return url.href; }
}

export function extractURLs(text) {
  const seen = new Set();
  return [...text.matchAll(/https?:\/\/[^\s<>\[\]"'`，。；）)]+/g)].map((match) => match[0]).filter((url) => {
    const key = canonicalURL(url);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
import { readFileSync } from 'node:fs';

export const CATALOG = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8')).sites;
