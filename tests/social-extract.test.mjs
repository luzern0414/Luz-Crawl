import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../lib/extract-page.mjs';
import { edgeAvailable, openTestBrowser } from './edge-page.mjs';
import { normalizeSocialRecord } from '../lib/social-schema.mjs';

test('normalizes an observed Xiaohongshu note state', () => {
  const result = normalizeSocialRecord({ platform: 'xhs', access_mode: 'public', state: { noteId: 'n1', title: '收纳', desc: '正文', time: '2026-10-30 08:30', user: { userId: 'u1', nickname: '小红' } }, comments: [] });
  assert.equal(result.post.id, 'n1');
  assert.equal(result.post.account.profile_url, null);
  assert.equal(result.post.published.iso, '2026-10-30T08:30:00+08:00');
  assert.equal(result.post.field_sources.published, 'page_state');
});

test('normalizes a visible Douyin author link and keeps loaded comments partial', () => {
  const result = normalizeSocialRecord({ platform: 'douyin', access_mode: 'public', post: { id: 'v1', text: '介绍', author: { name: '作者', handle: 'a1', profile_url: 'https://www.douyin.com/user/a1' } }, comments: [{ id: 'c1', text: '好看', account: { name: '评论者' } }], coverage: { displayed_total: 100, loaded: 1, all_comments_verified: false } });
  assert.equal(result.post.account.profile_url, 'https://www.douyin.com/user/a1');
  assert.equal(result.coverage.loaded, 1);
  assert.equal(result.coverage.all_comments_verified, false);
});

test('extracts state-backed Xiaohongshu post fields with source evidence', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><title>收纳</title></head><body>
      <main class="note-container">
        <h1 id="detail-title">收纳</h1><div id="detail-desc">正文内容</div>
        <div class="author-wrapper"><a href="https://www.xiaohongshu.com/user/profile/u1"><span class="name">小红</span></a></div>
        <time datetime="2026-10-30T08:30:00+08:00">2026-10-30</time>
        <div class="interact-container"><span class="like-wrapper"><span class="count">12</span></span><span class="chat-wrapper"><span class="count">2</span></span></div>
        <div class="comment-item" id="c1"><a class="user-name" href="https://www.xiaohongshu.com/user/profile/u2">小明</a><div class="content"><span class="note-text">好看</span></div><time datetime="2026-10-31T10:00:00+08:00">今天</time></div>
      </main>
      <script>window.__INITIAL_STATE__ = {note:{noteDetailMap:{n1:{note:{noteId:'n1',title:'收纳',desc:'正文内容',time:'2026-10-30 08:30',user:{userId:'u1',nickname:'小红'}}}}}};</script>
    </body></html>`);
    const result = await page.evaluate(extractPage, { platform: 'xhs', requestedURL: 'https://www.xiaohongshu.com/explore/n1', comments: true, includePresentation: false, access_mode: 'public' });
    assert.equal(result.post.id, 'n1');
    assert.equal(result.post.account.profile_url, 'https://www.xiaohongshu.com/user/profile/u1');
    assert.equal(result.post.published.iso, '2026-10-30T08:30:00+08:00');
    assert.equal(result.post.field_sources.published, 'page_state');
    assert.equal(result.comments[0].account.profile_url, 'https://www.xiaohongshu.com/user/profile/u2');
    assert.equal(result.access_mode, 'public');
  } finally { await browser.close(); }
});

test('extracts a visible Douyin author and marks loaded comments as partial', { skip: !edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><title>视频</title></head><body>
      <main data-e2e="video-detail"><h1>视频介绍</h1><div data-e2e="video-desc">介绍正文</div>
        <a data-e2e="detail-user-name" href="https://www.douyin.com/user/a1">作者</a>
        <time datetime="2026-10-29T12:00:00+08:00">2026-10-29</time>
        <div data-e2e="comment-list"><div data-e2e="comment-item" id="c1"><a href="https://www.douyin.com/user/c1">评论者</a><span data-e2e="comment-text">好看</span></div></div>
      </main></body></html>`);
    const result = await page.evaluate(extractPage, { platform: 'douyin', requestedURL: 'https://www.douyin.com/video/v1', comments: true, includePresentation: false, access_mode: 'public' });
    assert.equal(result.post.account.profile_url, 'https://www.douyin.com/user/a1');
    assert.equal(result.post.published.iso, '2026-10-29T12:00:00+08:00');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments_coverage.loaded, 1);
    assert.equal(result.comments_coverage.all_comments_verified, false);
  } finally { await browser.close(); }
});
