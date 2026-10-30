import fs from 'node:fs/promises';

// Records each capture or search outcome as an observation on the matching references/site-library.json entry
// (verification state per dimension plus probe counters). A lock file serialises concurrent sessions.
const LIBRARY = new URL('../references/site-library.json', import.meta.url);
const LOCK = new URL('../references/.site-library.lock', import.meta.url);
const UNRATED_STOPS = ['rate_limited', 'operation_budget', 'cancelled', 'site_blocked'];

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function pageField(url) {
  try { return ['/', ''].includes(new URL(url).pathname) ? 'page' : 'detail'; } catch { return 'page'; }
}

function observedState(row, isSearch) {
  if (isSearch) {
    if ((row.candidates || []).length) return 'verified';
    if (row.status === 'failed') return 'failed';
    return ['awaiting_user', 'blocked'].includes(row.status) ? 'blocked' : 'partial';
  }
  if (row.url_check?.valid_content) return row.status === 'captured' ? 'verified' : 'partial';
  if (['awaiting_user', 'blocked'].includes(row.status)) return 'blocked';
  return row.status === 'failed' ? 'failed' : 'partial';
}

export async function lzLibrary(rows) {
  let locked = false;
  for (let attempt = 0; attempt < 10 && !locked; attempt++) {
    try {
      await fs.writeFile(LOCK, String(process.pid), { flag: 'wx' });
      locked = true;
    } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!locked) return [];
  try {
    const library = JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
    const changed = [];
    const now = new Date().toISOString();
    for (const row of rows || []) {
      if (!row || UNRATED_STOPS.includes(row.stop_reason) || row.status === 'skipped') continue;
      const isSearch = row.query !== undefined || Array.isArray(row.candidates);
      const url = row.url_check?.resolved || row.resolved_url || row.url_check?.requested || row.url || row.search_url || '';
      const host = hostOf(url);
      const site = library.sites.find((item) => row.platform && item.id === row.platform) || (host && library.sites.find((item) => {
        const siteHost = hostOf(item.url);
        return siteHost && (host === siteHost || host.endsWith(`.${siteHost}`));
      }));
      if (!site) continue;
      const field = isSearch ? 'search' : pageField(url);
      let state = observedState(row, isSearch);
      // 已验证的能力只在明确失败或被拦截时降级：某个关键词没有结果不代表站内搜索不可用
      if (site.verification?.[field] === 'verified' && state === 'partial') state = 'verified';
      site.verification = { page: 'untested', search: 'untested', detail: 'untested', statistics: 'untested', media: 'untested', ...site.verification, [field]: state };
      site.probe = { ...site.probe, status: 'completed', observations: (site.probe?.observations || 0) + 1, observed_at: now, last_action_status: row.status, last_stop_reason: row.stop_reason || row.awaiting_reason || '', last_text_chars: row.completeness?.chars ?? 0 };
      changed.push(`${site.id} ${field}=${state}`);
    }
    if (changed.length) {
      library.updated_at = now;
      await fs.writeFile(LIBRARY, `${JSON.stringify(library, null, 2)}\n`);
      console.error(`[LuzCrawl] 站点库已更新：${changed.join('，')}`);
    }
    return changed;
  } catch (error) {
    console.error(`[LuzCrawl] site library update skipped: ${error.message}`);
    return [];
  } finally {
    await fs.rm(LOCK, { force: true });
  }
}
