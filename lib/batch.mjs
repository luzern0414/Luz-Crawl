import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, hashFile } from './archive.mjs';
import { canonicalURL, extractURLs, lzFixURL, platformOf, sourceURL, validateURL } from './platforms.mjs';
import { validateActions } from './browser-actions.mjs';
import { classifyFailure } from './failure.mjs';
import { writeCrawlSummary } from './crawl-summary.mjs';
import { roundSiteResolver, sites } from './memory.mjs';

export const DEFAULT_CONCURRENCY = 6;
export function batchConcurrency(value = DEFAULT_CONCURRENCY) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('--concurrency must be an integer from 1 to 8.');
  return count;
}

function searchEntry(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A search platform or domain is required.');
  const entry = value.trim();
  if (!/^[a-z0-9_-]+$/i.test(entry)) validateURL(entry.includes('://') ? entry : `https://${entry}`);
  return entry;
}

export async function readBatch(options) {
  batchConcurrency(options.concurrency);
  if (!options.file) throw new Error('--file is required.');
  const input = await fs.readFile(path.resolve(options.file), 'utf8');
  const rows = options.file.toLowerCase().endsWith('.json')
    ? JSON.parse(input.replace(/^\uFEFF/, ''))
    : extractURLs(input.split(/\r?\n/).map(line => line.trim() ? lzFixURL(line) : line).join('\n'));
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('A batch needs 1-500 URLs, {url, steps} jobs or {platform, query} search jobs.');
  return rows.map(row => {
    const job = typeof row === 'string' ? { url: row } : row;
    if (!job || typeof job !== 'object' || Array.isArray(job) || (job.query === undefined && Object.keys(job).some(key => !['id', 'url', 'steps'].includes(key)))) throw new Error('Batch jobs accept only id, url and optional steps, or a {platform, query} search.');
    if (job.id !== undefined && (typeof job.id !== 'string' || !job.id || job.id.length > 120)) throw new Error('Batch job id must be 1-120 characters.');
    if (job.query !== undefined) {
      if (Object.keys(job).some(key => !['id', 'platform', 'query', 'read', 'site', 'fallbacks', 'screenshot'].includes(key)) || typeof job.query !== 'string' || !job.query.trim() || job.query.length > 2000) {
        throw new Error('Search jobs accept id, platform, query, optional read (0-20), site, fallbacks and screenshot.');
      }
      const read = job.read === undefined ? undefined : Number(job.read);
      if (read !== undefined && (!Number.isInteger(read) || read < 0 || read > 20)) throw new Error('Search job read must be 0-20.');
      if (job.screenshot !== undefined && typeof job.screenshot !== 'boolean') throw new Error('Search job screenshot must be boolean.');
      if (job.fallbacks !== undefined && !Array.isArray(job.fallbacks)) throw new Error('Search job fallbacks must be an array of platforms.');
      const platform = searchEntry(job.platform);
      const fallbacks = [...new Set((job.fallbacks || []).map(searchEntry))].filter(entry => entry !== platform);
      return { id: job.id, platform, query: job.query.trim(), read, site: job.site ? String(job.site) : undefined, screenshot: job.screenshot,
        ...(fallbacks.length ? { fallbacks } : {}) };
    }
    const url = validateURL(lzFixURL(job.url)).href;
    return { ...(job.id ? { id: job.id } : {}), url, ...(job.steps !== undefined ? { steps: validateActions(job.steps, options['allow-write']) } : {}) };
  });
}

export async function siteQueueKey() {
  const searchHosts = new Map((await sites()).flatMap(site => [site.id, ...(site.aliases || [])]
    .map(name => [name.toLowerCase(), site.search || site.url])));
  return job => siteQueue(job, searchHosts);
}

function siteQueue(job, searchHosts) {
  let url = job.url;
  if (job.query !== undefined) {
    const id = job.platform.trim().toLowerCase();
    url = searchHosts.get(id);
    if (!url && !id.includes('.')) return id;
    url ||= id.includes('://') ? id : `https://${id}`;
  }
  const platform = platformOf(url);
  return platform === 'web' ? new URL(url).hostname : platform;
}

export function blockedReason(row) {
  const reason = row.awaiting_reason || row.stop_reason || row.failure?.code;
  if (['login_required', 'verification_required', 'rate_limited', 'access_denied', 'robots_disallowed', 'write_outcome_unknown'].includes(reason)
      || row.status === 'awaiting_user' || row.browser?.owned && !row.browser.closed) return reason || 'tab_cleanup_unconfirmed';
}

// Give each ready site one turn. A fallback enters its own site queue as soon as
// its preceding route finishes, even while unrelated slow sites are still busy.
export async function runSiteJobs(entries, concurrency, keyOf, visit, canStart = () => true) {
  const ready = [], lanes = new Map(), active = new Set();
  function enqueue(entry) {
    const key = keyOf(entry);
    if (!lanes.has(key)) {
      lanes.set(key, []);
      ready.push(key);
    }
    lanes.get(key).push(entry);
  }
  entries.forEach(enqueue);
  let firstError;
  while (ready.length || active.size) {
    while (!firstError && canStart() && active.size < concurrency && ready.length) {
      const key = ready.shift(), lane = lanes.get(key);
      const entry = lane.shift();
      const work = Promise.resolve().then(() => visit(entry, key)).then(next => {
        if (next) enqueue(next);
      }).catch(error => { firstError ??= error; }).finally(() => {
        active.delete(work);
        if (lane.length) ready.push(key);
        else lanes.delete(key);
      });
      active.add(work);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (firstError) throw firstError;
}

function verifiedBodies(row) {
  return (row.query === undefined ? [row] : row.sources || []).filter(source => source.folder && source.url_check?.valid_content === true
    && ['captured', 'partial'].includes(source.status));
}

function hasSearchEvidence(row) {
  return Boolean(row.candidates?.length || verifiedBodies(row).length);
}

function allRoutes(row) {
  return [...(row.previous_routes || []), row];
}

export async function batchReceipt(result) {
  const queries = new Set(), candidates = new Set(), sources = new Set();
  const awaitingUser = [], statuses = {};
  function addURL(set, value) {
    try { set.add(canonicalURL(value)); } catch { /* A malformed candidate is not a result. */ }
  }
  for (const job of result.results) {
    statuses[job.status] = (statuses[job.status] || 0) + 1;
    for (const row of allRoutes(job)) {
      if (row.search_performed === true && row.query) queries.add(row.query.trim().replace(/\s+/g, ' ').toLowerCase());
      for (const candidate of row.candidates || []) addURL(candidates, candidate.url);
      for (const source of verifiedBodies(row)) addURL(sources, source.resolved_url || source.url_check.resolved || source.url_check.requested || source.url);
      for (const item of [row, ...(row.sources || [])]) {
        if (item.status === 'awaiting_user' && item.task_id) awaitingUser.push({ id: row.id, task_id: item.task_id, reason: item.awaiting_reason || item.stop_reason });
      }
    }
  }
  const { status, batch_file, requested, attempted, settled, concurrency, summary_error } = result;
  return { status, requested, attempted, settled, concurrency, queries_executed: queries.size, candidate_count: candidates.size,
    verified_sources: sources.size, statuses, awaiting_user: awaitingUser, batch_file, batch_sha256: await hashFile(batch_file),
    summary_file: result.summary_report?.file, summary_error };
}

export async function batch(options, execute, { jobs, retry } = {}) {
  jobs ??= await readBatch(options);
  const concurrency = batchConcurrency(options.concurrency);
  const file = path.join(options.out, 'raw', `batch-${randomUUID()}.json`);
  const siteKey = await siteQueueKey();
  const resolveSearchSite = roundSiteResolver();
  const records = new Array(jobs.length);
  const history = jobs.map(() => []);
  const blockedSites = new Map();
  let writes = Promise.resolve();
  const snapshot = () => {
    const results = records.map((row, index) => history[index].length ? { ...row, previous_routes: [...history[index]] } : row).filter(Boolean);
    return { batch_file: file, plan_file: path.resolve(options.file), concurrency, requested: jobs.length,
      attempted: results.filter(row => allRoutes(row).some(attempt => attempt.status !== 'skipped')).length, settled: results.length, results };
  };
  const progressFile = file.replace(/\.json$/, '.progress.jsonl');
  const persist = (index, replace = false) => {
    const line = JSON.stringify({ index, replace, row: records[index] }) + '\n';
    writes = writes.then(() => fs.appendFile(progressFile, line));
    return writes;
  };
  const routeOptions = (job) => job.query !== undefined
    ? ['search', { ...options, resolveSearchSite, detailConcurrency: jobs.length === 1 ? concurrency : 1, file: undefined, deferSummary: true, window: 'background', park_on_block: true, platform: job.platform,
      query: job.query, read: job.read ?? options.read ?? 0, site: job.site, screenshot: options.screenshot !== false && job.screenshot !== false,
      scrolls: options.__optionSources?.scrolls === 'default' ? 12 : options.scrolls ?? 12 }]
    : [job.steps ? 'browser' : 'capture', { ...options, file: undefined, deferSummary: true, window: 'background', park_on_block: true, url: job.url, steps: job.steps }];
  const identity = job => job.query !== undefined
    ? { id: job.id, platform: job.platform, query: job.query, read: job.read ?? options.read ?? 0, site: job.site }
    : { ...(job.id ? { id: job.id } : {}), url: sourceURL(job.url), ...(job.steps ? { kind: 'browser' } : {}) };

  await atomicWrite(file, { ...snapshot(), status: 'running', progress_file: progressFile });
  await fs.writeFile(progressFile, '', { flag: 'wx' });
  await runSiteJobs(jobs.map((job, index) => ({ job, index })), concurrency, entry => siteKey(entry.job), async ({ job, index }, key) => {
    let next;
    if (records[index]) history[index].push(records[index]);
    const details = identity(job);
    if (blockedSites.has(key)) records[index] = { ...details, status: 'skipped', stop_reason: 'site_blocked', blocked_by: blockedSites.get(key) };
    else {
      const started_at = new Date().toISOString();
      let result;
      try { result = await execute(...routeOptions(job)); }
      catch (error) {
        const failure = classifyFailure(error);
        result = { status: 'failed', stop_reason: failure.code, error: failure.message, failure: failure.toJSON() };
      }
      records[index] = { ...result, ...details, ...(result.platform && result.platform !== job.platform && job.query !== undefined ? { resolved_platform: result.platform } : {}),
        started_at, finished_at: new Date().toISOString() };
      const reason = blockedReason(result);
      if (reason) blockedSites.set(key, reason);
      if (job.fallbacks?.length && !reason && !['cancelled', 'operation_budget'].includes(result.stop_reason) && !hasSearchEvidence(result)) {
        const [platform, ...fallbacks] = job.fallbacks;
        next = { job: { ...job, platform, fallbacks }, index };
      }
    }
    await persist(index);
    return next;
  });

  if (retry) {
    let attempted = 0;
    for (const [index, row] of records.entries()) {
      const job = { ...jobs[index], ...(row.query !== undefined ? { platform: row.platform, read: row.read } : {}) };
      const key = siteKey(job);
      if (attempted >= 20) break;
      if (job.steps || blockedSites.has(key) || ['captured', 'completed', 'awaiting_user', 'skipped'].includes(row.status)
          || ['cancelled', 'operation_budget'].includes(row.stop_reason) || verifiedBodies(row).length || row.query !== undefined && hasSearchEvidence(row)) continue;
      attempted++;
      let again;
      try { again = await retry(...routeOptions(job), row); }
      catch (error) { again = { status: 'failed', error: error.message }; }
      if (!again || again === row) continue;
      const handoff = blockedReason(again);
      if (handoff) blockedSites.set(key, handoff);
      const better = again.status === 'awaiting_user' || verifiedBodies({ ...again, query: row.query }).length || row.query !== undefined && hasSearchEvidence(again);
      if (better) {
        history[index].push(row);
        records[index] = { ...again, ...identity(job), started_at: row.started_at, finished_at: new Date().toISOString(),
          second_pass: { from: row.status, to: again.status } };
      } else {
        records[index] = { ...row, second_pass: { from: row.status, to: again.visible_fallback?.visible_status || again.status,
          error: again.visible_fallback?.visible_error || again.error } };
      }
      await persist(index, !better);
    }
  }
  const result = snapshot();
  result.status = result.results.every(row => ['captured', 'completed'].includes(row.status)) ? 'completed' : 'partial';
  await atomicWrite(file, result);
  try { result.summary_report = await writeCrawlSummary(options.out); }
  catch (error) { result.summary_error = error.message; }
  await atomicWrite(file, result);
  await fs.unlink(progressFile);
  return result;
}
