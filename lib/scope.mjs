import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, stateRoot } from './archive.mjs';
import { lzNote } from './notes.mjs';

// Per-topic crawl scope (scopes.json in the state root): which hosts gave verified content, which searches found
// candidates and which sources failed, summarised into one `scope:<task title>` fact note after each operation.
const UNRATED_STOPS = ['rate_limited', 'operation_budget', 'cancelled', 'site_blocked'];

function hostOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function lzScope(folder, rows) {
  try {
    let title;
    try { title = JSON.parse(await fs.readFile(path.join(folder, 'luz-task.json'), 'utf8')).title; } catch { return; }
    if (!title) return;
    const file = path.join(stateRoot(), 'scopes.json');
    let all = {};
    try { all = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
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
    const text = `主题「${title}」有效来源：${top(scope.good) || '暂无'}；有结果的检索：${top(scope.queries) || '暂无'}；无效：${bad || '暂无'}`.slice(0, 600);
    await lzNote({ kind: 'fact', key: `scope:${String(title).slice(0, 60)}`, text, why: '采集自动汇总' });
  } catch (error) {
    console.error(`[LuzCrawl] scope note skipped: ${error.message}`);
  }
}
