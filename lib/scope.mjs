import fs from 'node:fs/promises';
import path from 'node:path';
import { allocationLock, atomicWrite, findTaskArchive, stateRoot } from './archive.mjs';
import { lzNote } from './notes.mjs';

// Per-topic crawl observations: bodies captured, candidates found, and access
// failures. These observations never establish relevance or research acceptance.
const UNRATED_STOPS = ['rate_limited', 'operation_budget', 'cancelled', 'site_blocked'];

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function lzScope(folder, rows) {
  try {
    const title = (await findTaskArchive(folder))?.title;
    if (!title) return;
    await allocationLock(path.join(stateRoot(), 'locks', 'scopes'), () => recordScope(title, rows));
  } catch (error) {
    console.error(`[LuzCrawl] scope note skipped: ${error.message}`);
  }
}

async function recordScope(title, rows) {
  const file = path.join(stateRoot(), 'scopes.json');
  let all = {};
  try { all = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scope = all[title] || { good: {}, bad: {}, queries: {} };
  for (const row of rows || []) {
    if (!row || UNRATED_STOPS.includes(row.stop_reason) || row.status === 'skipped') continue;
    if (row.query !== undefined || Array.isArray(row.candidates)) {
      const key = `${row.platform || 'web'}「${String(row.query || '').slice(0, 30)}」`;
      const found = (row.candidates || []).length;
      if (found) {
        scope.queries[key] = Math.max(scope.queries[key] || 0, found);
        delete scope.bad[key];
      } else if (!scope.queries[key]) scope.bad[key] = row.stop_reason || row.status || '无结果';
      continue;
    }
    const host = hostOf(row.url_check?.resolved || row.resolved_url || row.url_check?.requested || row.url);
    if (!host) continue;
    if (row.url_check?.valid_content) {
      scope.good[host] = (scope.good[host] || 0) + 1;
      delete scope.bad[host];
    } else if (!scope.good[host]) scope.bad[host] = row.stop_reason || row.awaiting_reason || row.status;
  }
  all[title] = scope;
  await atomicWrite(file, all);
  const top = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, value]) => `${key}×${value}`).join('、');
  const bad = Object.entries(scope.bad).slice(0, 10).map(([key, value]) => `${key}（${value}）`).join('、');
  const text = `主题「${title}」采集观察（待语义复核）：${top(scope.good) || '暂无'}；发现候选的检索：${top(scope.queries) || '暂无'}；未取得内容的尝试：${bad || '暂无'}`.slice(0, 600);
  await lzNote({ kind: 'fact', category: 'source', outcome: 'unverified', key: `scope:${String(title).slice(0, 60)}`, text, when: '仅用于安排后续来源核验，不能替代阅读与采用决定', why: '采集自动汇总；数量是观察次数，不是去重或采用数量' });
}
