import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../lib/capture.mjs';
import { mergeCommentCoverage } from '../lib/social-schema.mjs';
import { testPolicy } from './helpers.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-comment-coverage-'));
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('displayed total does not imply full comment coverage', () => {
  const coverage = mergeCommentCoverage({ displayed_total: 200, loaded: 8, all_comments_verified: false, batches: 2, stop_reason: 'no_new_comments' });
  assert.equal(coverage.loaded, 8);
  assert.equal(coverage.displayed_total, 200);
  assert.equal(coverage.all_comments_verified, false);
  assert.equal(coverage.stop_reason, 'no_new_comments');
});

test('a terminal login or rate limit stops comment scrolling with an evidence batch', () => {
  const coverage = mergeCommentCoverage({ displayed_total: 50, loaded: 3, batches: 1, stop_reason: 'login_required' });
  assert.equal(coverage.batches, 1);
  assert.equal(coverage.all_comments_verified, false);
});

test('coverage merge keeps the latest measured batch and never overstates loaded comments', () => {
  const coverage = mergeCommentCoverage(
    { displayed_total: 20, loaded: 3, batches: 1, stop_reason: null, all_comments_verified: false },
    { displayed_total: 20, loaded: 5, batches: 2, stop_reason: 'page_end', all_comments_verified: false },
  );
  assert.deepEqual(coverage, { loaded: 5, displayed_total: 20, all_comments_verified: false, batches: 2, stop_reason: 'page_end' });
});

test('social capture deduplicates virtual comments and reports partial page-end coverage', async () => {
  const url = 'https://www.xiaohongshu.com/explore/n1';
  const body = '这是笔记正文，足够证明目标内容已经在页面中加载。';
  const base = (comments, at_bottom) => ({
    url, title: '收纳', text: body, html: `<main>${body}</main>`,
    presentation: { html: `<main>${body}</main>`, text_chars: body.length, assets: [], width: 600 },
    items: [{ id: 'n1', url, kind: 'page_body', text: body }], media: [], links: [], transcript: [], article_links: [], target_present: true,
    gate: null, loading: false, post: { id: 'n1', text: body, title: '收纳', engagement: { comments: { raw: '5', value: 5 } }, account: { name: '小红', profile_url: 'https://www.xiaohongshu.com/user/profile/u1' } },
    comments, comments_coverage: { loaded: comments.length, displayed_total: 5, all_comments_verified: false }, scroll: { at_bottom, height: 2000, top: at_bottom ? 1400 : 0, viewport: 600 },
  });
  const snapshots = [
    base([{ id: 'c1', text: '好看', account: { name: '小明' } }], false),
    base([{ id: 'c1', text: '好看', account: { name: '小明' } }, { id: 'c2', text: '实用', account: { name: '小王' } }], true),
    base([{ id: 'c2', text: '实用', account: { name: '小王' } }], true),
  ];
  let index = 0;
  const page = {
    goto: async () => {},
    evaluate: async (code) => {
      if (code === 'location.href') return url;
      if (code.includes('function extractPage')) return snapshots[Math.min(index++, snapshots.length - 1)];
      if (code.includes('function expandPage')) return [];
      if (code.includes('function scrollPage')) return { at_bottom: true, height: 2000, top: 1400, viewport: 600 };
      if (code.includes('function dismissLoginGate')) return [];
      throw new Error('Unexpected browser operation');
    },
  };
  const result = await capture(page, { url, out: path.join(temp, 'capture'), executionPolicy: testPolicy(temp), delay: 0, scrolls: 5, comments: true, screenshot: false });
  assert.equal(result.status, 'partial');
  assert.equal(result.stop_reason, 'page_end');
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments_coverage.loaded, 2);
  assert.equal(result.comments_coverage.displayed_total, 5);
  assert.equal(result.comments_coverage.all_comments_verified, false);
});
