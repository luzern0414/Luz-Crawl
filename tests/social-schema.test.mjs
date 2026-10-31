import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSocialTime,
  expandSocialQueries,
  dedupeSocialComments,
  selectAdaptiveBudget,
} from '../lib/social-schema.mjs';

test('parses ISO, unix seconds, unix milliseconds and relative Chinese time without guessing', () => {
  const now = new Date('2026-10-31T12:00:00+08:00');
  assert.equal(parseSocialTime('2026-10-30 08:30', now, 'Asia/Shanghai').iso, '2026-10-30T08:30:00+08:00');
  assert.equal(parseSocialTime(1793419200, now, 'Asia/Shanghai').precision, 'second');
  assert.equal(parseSocialTime(1793419200000, now, 'Asia/Shanghai').precision, 'millisecond');
  assert.equal(parseSocialTime('3小时前', now, 'Asia/Shanghai').iso, '2026-10-31T09:00:00+08:00');
  assert.equal(parseSocialTime('未知时间', now, 'Asia/Shanghai').iso, null);
});

test('keeps the original query and creates bounded social variants', () => {
  const plan = expandSocialQueries('小红书 家居 收纳 评论 用户', { platform: 'xhs', maxQueries: 8 });
  assert.equal(plan.original, '小红书 家居 收纳 评论 用户');
  assert(plan.queries.length <= 8);
  assert(plan.queries.some(item => /家居|收纳/.test(item.query)));
  assert(plan.queries.every(item => item.query && item.purpose));
});

test('deduplicates virtual-list comments by id and content fingerprint', () => {
  const result = dedupeSocialComments([
    { id: 'c1', text: '好看', account: { id: 'u1' } },
    { id: 'c1', text: '好看', account: { id: 'u1' } },
    { text: '不错', account: { name: '小明' }, published: { iso: '2026-10-31T10:00:00Z' } },
    { text: '不错', account: { name: '小明' }, published: { iso: '2026-10-31T10:00:00Z' } },
  ]);
  assert.equal(result.comments.length, 2);
  assert.equal(result.duplicates, 2);
});

test('expands detail budget when candidates exceed the requested read count', () => {
  const plan = selectAdaptiveBudget({ candidates: 40, read: 5, comments: true, base: 5, failures: 2, hardMax: 20 });
  assert.equal(plan.detail_limit, 10);
  assert(plan.next_batch >= plan.detail_limit);
  assert.equal(plan.stop_reason, null);
});
