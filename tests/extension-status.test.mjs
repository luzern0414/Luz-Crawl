import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskStatus } from '../browser-extension/popup-status.js';

test('formats public adaptive progress', () => {
  assert.equal(formatTaskStatus({ access_mode: 'public', query_count: 4, candidate_count: 18, verified_count: 6, comment_loaded: 21 }), '公开页面 · 查询 4 · 候选 18 · 详情 6 · 评论 21');
});

test('formats a manual verification stop', () => {
  assert.equal(formatTaskStatus({ access_mode: 'authorized_browser', stop_reason: 'verification_required' }), '已连接浏览器授权 · 等待手动验证');
});

test('keeps progress counts visible while a task is waiting for verification', () => {
  assert.equal(formatTaskStatus({ access_mode: 'public', stage: 'comments', query_current: '收纳技巧', query_count: 3, candidate_count: 12, verified_count: 4, comment_loaded: 18, stop_reason: 'verification_required' }), '公开页面 · 加载评论 · 词 收纳技巧 · 查询 3 · 候选 12 · 详情 4 · 评论 18 · 等待手动验证');
});
