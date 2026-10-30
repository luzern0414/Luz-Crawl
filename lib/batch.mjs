import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './archive.mjs';
import { extractURLs, lzFixURL, platformOf, sourceURL, validateURL } from './platforms.mjs';
import { validateActions } from './browser-actions.mjs';
import { classifyFailure } from './failure.mjs';
import { writeCrawlSummary } from './crawl-summary.mjs';

export function batchConcurrency(value = 4) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error('--concurrency must be an integer from 1 to 6.');
  return count;
}

export async function readBatch(options) {
  batchConcurrency(options.concurrency);
  if (!options.file) throw new Error('--file is required.');
  const input = await fs.readFile(path.resolve(options.file), 'utf8');
  const rows = options.file.toLowerCase().endsWith('.json')
    ? JSON.parse(input)
    : extractURLs(input.split(/\r?\n/).map(line => line.trim() ? lzFixURL(line) : line).join('\n'));
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('A batch needs 1-500 URLs, {url, steps} jobs or {platform, query} search jobs.');
  return rows.map(row => {
    const job = typeof row === 'string' ? { url: row } : row;
    if (!job || typeof job !== 'object' || Array.isArray(job) || (job.query === undefined && Object.keys(job).some(key => !['id', 'url', 'steps'].includes(key)))) throw new Error('Batch jobs accept only id, url and optional steps, or a {platform, query} search.');
    if (job.id !== undefined && (typeof job.id !== 'string' || !job.id || job.id.length > 120)) throw new Error('Batch job id must be 1-120 characters.');
    if (job.query !== undefined) {
      if (Object.keys(job).some(key => !['id', 'platform', 'query', 'read', 'site'].includes(key)) || typeof job.platform !== 'string' || !job.platform || typeof job.query !== 'string' || !job.query.trim() || job.query.length > 500) {
        throw new Error('Search jobs accept id, platform, query, optional read (0-20) and site.');
      }
      const read = job.read === undefined ? undefined : Number(job.read);
      if (read !== undefined && (!Number.isInteger(read) || read < 0 || read > 20)) throw new Error('Search job read must be 0-20.');
      return { ...(job.id ? { id: job.id } : {}), platform: job.platform, query: job.query.trim(), ...(read !== undefined ? { read } : {}), ...(job.site ? { site: String(job.site) } : {}) };
    }
    const url = validateURL(lzFixURL(job.url)).href;
    return { ...(job.id ? { id: job.id } : {}), url, ...(job.steps !== undefined ? { steps: validateActions(job.steps, options['allow-write']) } : {}) };
  });
}

export async function batch(options, execute) {
  const jobs = await readBatch(options);
  const concurrency = batchConcurrency(options.concurrency);
  const file = path.join(options.out, `batch-${randomUUID()}.json`);
  const groups = new Map();
  for (const [index, job] of jobs.entries()) {
    // Search jobs queue per search site (site domain, else platform); page jobs per platform or host.
    const platform = job.query !== undefined ? job.platform : platformOf(job.url);
    const key = job.query !== undefined ? 'search:' + (job.site || job.platform) : platform === 'web' ? new URL(job.url).hostname : platform;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ job, index });
  }
  const lanes = [...groups.values()];
  const records = new Array(jobs.length);
  let cursor = 0, writes = Promise.resolve();
  const snapshot = () => {
    const results = records.filter(Boolean);
    return { batch_file: file, concurrency, requested: jobs.length, attempted: results.filter(row => row.status !== 'skipped').length, settled: results.length, results };
  };
  const persist = () => {
    const data = snapshot();
    writes = writes.then(() => atomicWrite(file, data));
    return writes;
  };
  await persist();
  const worker = async () => {
    while (cursor < lanes.length) {
      const lane = lanes[cursor++];
      let blocked;
      for (const { job, index } of lane) {
        const identity = { ...(job.id ? { id: job.id } : {}), ...(job.query !== undefined ? { platform: job.platform, query: job.query } : { url: sourceURL(job.url) }) };
        if (blocked) records[index] = { ...identity, status: 'skipped', stop_reason: 'site_blocked', blocked_by: blocked };
        else {
          const started_at = new Date().toISOString();
          let result;
          try {
            if (job.query !== undefined) result = await execute('search', { ...options, file: undefined, platform: job.platform, query: job.query, read: job.read ?? options.read ?? 0, site: job.site, scrolls: options.scrolls ?? 12, window: 'background', park_on_block: true });
            else result = await execute(job.steps ? 'browser' : 'capture', { ...options, file: undefined, steps: job.steps, url: job.url, window: 'background', park_on_block: true });
          }
          catch (error) { const failure = classifyFailure(error); result = { status: 'failed', stop_reason: failure.code, error: failure.message, failure: failure.toJSON() }; }
          records[index] = { ...result, ...identity, started_at, finished_at: new Date().toISOString() };
          const reason = result.awaiting_reason || result.stop_reason || result.failure?.code;
          if (['login_required', 'verification_required', 'rate_limited'].includes(reason) || result.status === 'awaiting_user' || result.browser?.owned && !result.browser.closed) blocked = reason || 'tab_cleanup_unconfirmed';
        }
        await persist();
      }
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, lanes.length) }, worker));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const result = snapshot();
  result.status = result.results.every(row => ['captured', 'completed'].includes(row.status)) ? 'completed' : 'partial';
  await atomicWrite(file, result);
  try { result.summary_report = await writeCrawlSummary(options.out); }
  catch (error) { result.summary_error = error.message; }
  await atomicWrite(file, result);
  return result;
}
