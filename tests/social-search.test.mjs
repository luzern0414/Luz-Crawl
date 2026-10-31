import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { search } from '../lib/search.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-social-search-'));
test.after(() => fs.rm(temp, { recursive: true, force: true }));

async function savedCapture(calls, options, links = []) {
  calls.push(options);
  const folder = path.join(options.out, 'raw', `capture-${calls.length}`);
  await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
  await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: options.query || '', links }));
  return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: Boolean(options.query), effect_verified: true }, limitations: [] };
}

test('social search preserves the original query and records a bounded expansion', async () => {
  const calls = [];
  const operations = { summary: () => ({ browser_calls: calls.length }), navigate: async () => {}, evaluate: async () => true, policy: { waitUntil: async () => ({ satisfied: true, last: true }) } };
  const result = await search({}, { platform: 'xhs', query: '家居 收纳', read: 2, out: path.join(temp, 'xhs') }, operations, (page, options) => savedCapture(calls, options, [
    { url: 'https://www.xiaohongshu.com/explore/abc123', text: '家居 收纳 笔记', context: '家居 收纳 笔记 作者 2026' },
  ]));
  assert.equal(result.query, '家居 收纳');
  assert(result.query_plan.queries.length <= 8);
  assert.equal(result.query_plan.original, '家居 收纳');
  assert(Array.isArray(result.search_queries));
  assert(calls.length >= 1);
  assert(result.candidates[0].search_evidence);
});

test('social detail failure continues to the next candidate and records stop reasons', async () => {
  let details = 0;
  const calls = [];
  const operations = { summary: () => ({ browser_calls: calls.length }), navigate: async () => {}, evaluate: async () => true, policy: { waitUntil: async () => ({ satisfied: true, last: true }) } };
  const capture = async (_page, options) => {
    calls.push(options);
    const folder = path.join(options.out, 'raw', `capture-${calls.length}`);
    await fs.mkdir(path.join(folder, 'raw'), { recursive: true });
    if (!options.query) {
      details++;
      await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, links: [] }));
      if (details === 1) return { folder, status: 'blocked', stop_reason: 'unavailable', url_check: { valid_content: false }, limitations: [] };
      return { folder, status: 'captured', stop_reason: 'stable_after_2_scrolls', url_check: { valid_content: true }, post: { id: 'v2' }, limitations: [] };
    }
    await fs.writeFile(path.join(folder, 'raw', 'content.json'), JSON.stringify({ requested_url: options.url, text: options.query, links: [
      { url: 'https://www.douyin.com/video/111', text: '主题 视频 1', context: '主题 视频 作者 一' },
      { url: 'https://www.douyin.com/video/222', text: '主题 视频 2', context: '主题 视频 作者 二' },
    ] }));
    return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true, effect_verified: true }, limitations: [] };
  };
  const result = await search({}, { platform: 'douyin', query: '主题', read: 1, out: path.join(temp, 'douyin') }, operations, capture);
  assert.equal(result.verified_sources, 1);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].stop_reason, 'unavailable');
  assert(result.adaptive_budget.detail_limit >= 2);
});
