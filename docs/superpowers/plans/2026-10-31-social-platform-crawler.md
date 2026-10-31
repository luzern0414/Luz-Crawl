# 小红书与抖音检索采集增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为小红书笔记和抖音视频增加可核验的关键词扩展、统一详情/作者/时间/评论字段、自适应详情补采和插件状态展示，同时保持 GitHub 多路线检索和公开页面优先。

**Architecture:** 新增纯函数模块 `lib/social-schema.mjs`，负责时间解析、查询扩展、统一记录、评论去重和预算计算；`extract-page.mjs` 只读取页面状态与可见 DOM，`search.mjs` 编排查询、候选和详情，`capture.mjs` 负责评论容器滚动和覆盖证据。插件只读取后台状态并展示模式、进度和停止原因，不保存凭据。

**Tech Stack:** Node.js ESM（>=24.5.0）、Node 内置 `node:test`、真实 Edge 浏览器桥接、Manifest V3 扩展、现有 JSON/HTML 归档格式。

## Global Constraints

- 只读取真实浏览器已呈现的页面状态、JSON-LD、初始化状态和可见 DOM。
- 公开页面优先；只有用户明确授权并提供已连接浏览器时才读取登录态，并将两种结果分开标记。
- 不接入签名破解、逆向接口、代理池、验证码绕过、Cookie/令牌导出或无许可证代码。
- 评论只代表本次页面实际加载的条目；显示总数不能当作已抓全。
- 自适应批量必须有页面预算、站点停止条件和硬上限；失败候选要继续尝试下一个候选。
- 所有新增字段保留原始值、解析值、来源类型和解析错误；无法确认的时间写 `iso: null`。
- 使用 `npm test`、`git diff --check`、`node scripts/luz-crawl.mjs doctor` 和 Luz-Dev delivery check 验证。

---

### Task 0: 技术方案门禁与版本基线

**Files:**
- Modify: `D:/Codes/skill输出/Luz-Dev/09-小红书抖音检索采集增强技术方案/raw/plan.json` only through `tech_plan.py` commands
- Modify: `package.json`
- Modify: `browser-extension/manifest.json`

**Interfaces:**
- Consumes: 已提交的 Luz-Dev 方案 09 和用户对方案 B 的明确批准。
- Produces: `tech_plan.py gate 09` 通过；包和扩展版本统一为 `3.3.0`。

- [ ] **Step 1: Obtain explicit technical-plan approval**

  Ask the user to approve the submitted HTML at `D:\Codes\skill输出\Luz-Dev\09-小红书抖音检索采集增强技术方案\09-小红书抖音检索采集增强技术方案.html`. Record the exact approval text with:

  ```powershell
  python -X utf8 D:\Codes\Luz-Dev\scripts\tech_plan.py approve 09 --note "用户批准技术方案的原话"
  ```

- [ ] **Step 2: Run the development gate before changing code**

  ```powershell
  python -X utf8 D:\Codes\Luz-Dev\scripts\tech_plan.py gate 09
  ```

  Expected: `ok: true` and no content-hash or approval error.

- [ ] **Step 3: Update the two version declarations**

  Change `package.json` `version` and `browser-extension/manifest.json` `version`/`version_name` from `3.2.2` to `3.3.0`; keep the existing package name and scripts.

- [ ] **Step 4: Verify version and commit**

  ```powershell
  node -e "const p=require('./package.json'); if(p.version!=='3.3.0') process.exit(1)"
  node --input-type=module -e "const p=JSON.parse(await (await import('node:fs/promises')).readFile('browser-extension/manifest.json')); if(p.version!=='3.3.0') process.exit(1)"
  git diff --check
  git add package.json browser-extension/manifest.json
  git commit -m "chore: bump crawler package to 3.3.0"
  ```

### Task 1: Add pure social schema helpers

**Files:**
- Create: `lib/social-schema.mjs`
- Create: `tests/social-schema.test.mjs`

**Interfaces:**
- Consumes: platform name, page text/state objects, candidate summaries, comment arrays and current time.
- Produces: `parseSocialTime`, `expandSocialQueries`, `normalizeSocialRecord`, `dedupeSocialComments`, `selectAdaptiveBudget` exports used by later tasks.

- [ ] **Step 1: Write the failing tests**

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { parseSocialTime, expandSocialQueries, dedupeSocialComments, selectAdaptiveBudget } from '../lib/social-schema.mjs';

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
      { text: '不错', account: { name: '小明' }, published: { iso: '2026-10-31T10:00:00Z' } }
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
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  ```powershell
  node --test tests/social-schema.test.mjs
  ```

  Expected: FAIL because `lib/social-schema.mjs` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

  Export these signatures and keep them dependency-free:

  ```js
  export function parseSocialTime(value, now = new Date(), timezone = 'Asia/Shanghai') { /* return raw/iso/timezone/precision/source/parse_error */ }
  export function expandSocialQueries(request, { platform = 'web', maxQueries = 8, extraTerms = [] } = {}) { /* return original, facets, queries, suggested_queries */ }
  export function dedupeSocialComments(comments = []) { /* return { comments, duplicates, keys } */ }
  export function normalizeSocialRecord(input = {}) { /* return post, account, comments, coverage, field_sources, access_mode */ }
  export function selectAdaptiveBudget({ candidates = 0, read = 0, comments = false, base = 5, failures = 0, hardMax = 20 } = {}) { /* return detail_limit/comment_limit/next_batch/stop_reason */ }
  ```

  Use explicit regexes for ISO, Unix seconds/milliseconds, `刚刚`, `分钟前`, `小时前`, `昨天`, and `YYYY-MM-DD`/`YYYY-MM-DD HH:mm`; return `iso: null` and `parse_error: 'unrecognized'` for unknown text.

- [ ] **Step 4: Run the focused test and full regression**

  ```powershell
  node --test tests/social-schema.test.mjs
  npm test
  ```

  Expected: four focused tests and all pre-existing tests PASS.

- [ ] **Step 5: Commit**

  ```powershell
  git add lib/social-schema.mjs tests/social-schema.test.mjs
  git commit -m "feat: add social query and record schema helpers"
  ```

### Task 2: Normalize Xiaohongshu and Douyin page extraction

**Files:**
- Modify: `lib/extract-page.mjs`
- Create: `tests/social-extract.test.mjs`

**Interfaces:**
- Consumes: `parseSocialTime` and `normalizeSocialRecord` from Task 1, plus current page state and visible DOM selectors.
- Produces: existing `post`, `items`, `comments` compatibility fields plus `post.published`, `post.field_sources`, `post.access_mode`, `comments_coverage`, and uniform `account` objects.

- [ ] **Step 1: Add failing extraction fixture tests**

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
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
  ```

- [ ] **Step 2: Run the fixture test and verify it fails**

  ```powershell
  node --test tests/social-extract.test.mjs
  ```

  Expected: FAIL because the current record has no uniform published/source/coverage fields.

- [ ] **Step 3: Implement state-first extraction and DOM fallback**

  In `extractPage`, add local readers with this order: xhs `window.__INITIAL_STATE__.note.noteDetailMap`, douyin JSON-LD/initial state, then visible DOM. For both platforms, collect author name/id/profile URL, title, body, raw time, engagement and media. Every collected value gets a source from `page_state`, `json_ld`, `dom`, `visible_text`, or `observed_media`; do not infer missing dates.

  Normalize the result with:

  ```js
  const social = normalizeSocialRecord({ platform, requestedURL, access_mode: options.access_mode || 'public', post: rawPost, comments: extractedComments, coverage: { displayed_total: engagement.comments?.value ?? null, loaded: extractedComments.length, all_comments_verified: false } });
  post = { ...post, ...social.post, field_sources: social.field_sources, access_mode: social.access_mode };
  extractedComments = social.comments;
  ```

  Keep old selector fallbacks and old `items` shape so other platforms and existing exports continue to work.

- [ ] **Step 4: Verify extraction and run regression**

  ```powershell
  node --test tests/social-extract.test.mjs tests/social-schema.test.mjs
  npm test
  ```

  Expected: all targeted and existing tests PASS.

- [ ] **Step 5: Commit**

  ```powershell
  git add lib/extract-page.mjs tests/social-extract.test.mjs
  git commit -m "feat: normalize social post and comment extraction"
  ```

### Task 3: Add social search planning and adaptive detail attempts

**Files:**
- Modify: `lib/search.mjs`
- Modify: `lib/platforms.mjs` or `data/catalog.json` only if a missing public route is proven by a fixture
- Create: `tests/social-search.test.mjs`

**Interfaces:**
- Consumes: `expandSocialQueries` and `selectAdaptiveBudget` from Task 1, existing `sourceCandidates`, URL validators and `capturePage`.
- Produces: xhs/douyin `query_plan`, `search_queries`, `related_terms`, candidate evidence, adaptive detail limits, and attempt-level failure records.

- [ ] **Step 1: Write failing search orchestration tests**

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { search } from '../lib/search.mjs';

  test('social search preserves the original query and records a bounded expansion', async () => {
    const calls = [];
    const capture = async (_page, options) => {
      calls.push(options);
      const folder = options.out;
      return { folder, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
    };
    const result = await search({}, { platform: 'xhs', query: '家居 收纳', read: 2, out: 'test-output' }, { summary: () => ({}) }, capture);
    assert.equal(result.query, '家居 收纳');
    assert(result.query_plan.queries.length <= 8);
    assert(Array.isArray(result.search_queries));
    assert(calls.length >= 1);
  });

  test('social detail failure continues to the next candidate and records stop reasons', async () => {
    let details = 0;
    const capture = async (_page, options) => {
      if (!options.query) { details++; if (details === 1) return { status: 'blocked', stop_reason: 'unavailable', url_check: { valid_content: false } }; return { status: 'captured', stop_reason: 'stable_after_2_scrolls', url_check: { valid_content: true }, post: { id: 'v2' }, limitations: [] }; }
      return { folder: options.out, status: 'captured', resolved_url: options.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [], links: [{ url: 'https://www.douyin.com/video/v1', text: 'v1', context: '主题 视频' }, { url: 'https://www.douyin.com/video/v2', text: 'v2', context: '主题 视频' }] };
    };
    const result = await search({}, { platform: 'douyin', query: '主题', read: 1, out: 'test-output' }, { summary: () => ({}) }, capture);
    assert.equal(result.verified_sources, 1);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].stop_reason, 'unavailable');
  });
  ```

- [ ] **Step 2: Run the focused tests and verify they fail**

  ```powershell
  node --test tests/social-search.test.mjs
  ```

  Expected: FAIL because xhs/douyin currently have no query plan and the detail loop uses a fixed `read` limit.

- [ ] **Step 3: Implement bounded social routes and adaptive detail loop**

  Add `queryPlan = ['xhs','douyin'].includes(site.id) ? expandSocialQueries(...) : null`. Build native routes from the plan, then one related-term pass from candidate `context`/tags, then Bing `site:` routes. Merge candidates by `canonicalURL`, reject navigation/recommendation/login URLs, and attach `search_evidence` plus `query_variant`.

  Replace the fixed social detail limit with:

  ```js
  const adaptive = selectAdaptiveBudget({ candidates: candidates.length, read: count, comments: Boolean(kwargs.comments), base: Math.max(3, count), failures: 0, hardMax: Math.max(20, count * 4) });
  const detailAttemptLimit = Math.min(candidates.length, adaptive.detail_limit);
  ```

  Iterate until the requested number of valid sources is reached or the adaptive hard limit/terminal stop is hit. Push `{ url, query_variant, status, stop_reason, url_check }` into `sources` for every attempted candidate. Return `search_queries`, `related_terms`, `adaptive_budget`, `access_mode`, `requires_user` and `awaiting_reason` without dropping the existing GitHub fields.

- [ ] **Step 4: Verify social routes, GitHub regression and full suite**

  ```powershell
  node --test tests/social-search.test.mjs tests/github-search.test.mjs tests/search-safety.test.mjs
  npm test
  ```

  Expected: social tests pass and all existing GitHub fallback/filter tests remain green.

- [ ] **Step 5: Commit**

  ```powershell
  git add lib/search.mjs lib/platforms.mjs data/catalog.json tests/social-search.test.mjs
  git commit -m "feat: add social query expansion and adaptive detail search"
  ```

### Task 4: Make comment capture measurable and bounded

**Files:**
- Modify: `lib/capture.mjs`
- Modify: `lib/extract-page.mjs` only for comment-container metadata
- Create: `tests/comment-coverage.test.mjs`

**Interfaces:**
- Consumes: normalized comments and `dedupeSocialComments` from Task 1; existing comment container selectors and scroll operations.
- Produces: `comments_coverage = { loaded, displayed_total, all_comments_verified, batches, stop_reason }` and honest `partial` status when coverage is incomplete.

- [ ] **Step 1: Write failing coverage tests**

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { mergeCommentCoverage } from '../lib/social-schema.mjs';

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
  ```

- [ ] **Step 2: Run the focused tests and verify failure**

  ```powershell
  node --test tests/comment-coverage.test.mjs
  ```

  Expected: FAIL because `mergeCommentCoverage` and batch tracking do not exist.

- [ ] **Step 3: Implement container-only scrolling and coverage merge**

  Add `mergeCommentCoverage(previous, next)` to `lib/social-schema.mjs`. In `capture`, after each snapshot merge comments through `dedupeSocialComments`, increment `batches` only when the unique count grows, and stop with one of `no_new_comments`, `comment_budget`, `page_end`, `login_required`, `verification_required`, `rate_limited`, `operation_budget`, or `cancelled`. Do not scroll `document` while a platform comment container exists.

  Replace the unconditional comment limitation with the measured object and set `result.status = 'partial'` whenever `displayed_total > loaded` or a terminal stop occurred before verified end.

- [ ] **Step 4: Verify comment behavior and regression**

  ```powershell
  node --test tests/comment-coverage.test.mjs tests/capture.test.mjs
  npm test
  ```

  Expected: coverage tests and existing capture lifecycle tests pass.

- [ ] **Step 5: Commit**

  ```powershell
  git add lib/social-schema.mjs lib/capture.mjs lib/extract-page.mjs tests/comment-coverage.test.mjs
  git commit -m "feat: record bounded social comment coverage"
  ```

### Task 5: Expose access mode and adaptive progress in the extension

**Files:**
- Modify: `browser-extension/popup.html`
- Modify: `browser-extension/popup.js`
- Modify: `browser-extension/dist/background.js` only through the existing `getStatus` message path
- Modify: `browser-extension/help.html`
- Create: `tests/extension-status.test.mjs` if status rendering helpers are extracted

**Interfaces:**
- Consumes: existing `getStatus` daemon response and optional task progress fields (`access_mode`, `query_count`, `candidate_count`, `verified_count`, `comment_loaded`, `stop_reason`).
- Produces: compact Chinese UI showing connection, mode, task progress, stop reason and version; no credential inputs.

- [ ] **Step 1: Write failing status-format tests**

  Extract a pure `formatTaskStatus(status)` helper from `popup.js` and test:

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { formatTaskStatus } from '../browser-extension/popup-status.js';

  test('formats public adaptive progress', () => {
    assert.equal(formatTaskStatus({ access_mode: 'public', query_count: 4, candidate_count: 18, verified_count: 6, comment_loaded: 21 }), '公开页面 · 查询 4 · 候选 18 · 详情 6 · 评论 21');
  });

  test('formats a manual verification stop', () => {
    assert.equal(formatTaskStatus({ access_mode: 'authorized_browser', stop_reason: 'verification_required' }), '已连接浏览器授权 · 等待手动验证');
  });
  ```

- [ ] **Step 2: Run and verify failure**

  ```powershell
  node --test tests/extension-status.test.mjs
  ```

  Expected: FAIL because the status helper and progress fields are absent.

- [ ] **Step 3: Implement the compact status card**

  Add `browser-extension/popup-status.js` with `formatTaskStatus`, import it in `popup.js`, and add rows for mode, task progress, and stop reason. Poll `getStatus` at a bounded interval only while the popup is open; retain the current connection/profile and output directory controls. Display `公开页面优先` or `已连接浏览器授权` and never display Cookie, token or proxy fields.

- [ ] **Step 4: Update help and extension metadata**

  Rewrite `help.html` to three short parts: 功能、作用、操作方法. Remove author/upstream/source paragraphs from user-facing help while keeping `LICENSE` and `NOTICE`. Update `manifest.json` version name to `LuzCrawl 3.3.0`.

- [ ] **Step 5: Verify extension files and commit**

  ```powershell
  node --check browser-extension/popup.js
  node --check browser-extension/popup-status.js
  node --test tests/extension-status.test.mjs
  git diff --check
  git add browser-extension/popup.html browser-extension/popup.js browser-extension/popup-status.js browser-extension/help.html browser-extension/manifest.json tests/extension-status.test.mjs
  git commit -m "feat: show social crawl mode and progress in extension"
  ```

### Task 6: Simplify project-facing documentation and package metadata

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `references/site-library.json` only to preserve the existing GitHub verification update

**Interfaces:**
- Consumes: final CLI fields, extension states and version `3.3.0` from Tasks 1–5.
- Produces: concise Chinese documentation with function, purpose and operation only; no redundant author/source/background content.

- [ ] **Step 1: Write documentation acceptance checks**

  ```powershell
  rg -n "作者|上游|来源|鸣谢|背景介绍|宣传" SKILL.md README.md browser-extension/help.html
  ```

  Expected after the edit: no matches in user-facing docs; legal license files remain unchanged.

- [ ] **Step 2: Update the skill command reference**

  Add one concise section describing:

  ```text
  search --platform xhs|douyin --query "主题" --read N --comments
  capture "公开笔记或视频 URL" --comments
  ```

  Explain that output includes actual queries, candidate evidence, post/account/time/comment fields, loaded comment count and stop reason; explain public-first and manual authorized-browser behavior in two sentences.

- [ ] **Step 3: Update README and changelog**

  Keep only 功能、作用、操作方法, version `3.3.0`, validation commands and a short change list. Remove duplicated project history and research narrative from README.

- [ ] **Step 4: Verify docs and commit**

  ```powershell
  node --check lib/social-schema.mjs
  rg -n "作者|上游|来源|鸣谢|背景介绍|宣传" SKILL.md README.md browser-extension/help.html
  git diff --check
  npm test
  git add SKILL.md README.md CHANGELOG.md package.json references/site-library.json
  git commit -m "docs: simplify crawler usage and social search reference"
  ```

### Task 7: End-to-end fixtures, checks, and delivery evidence

**Files:**
- Modify: relevant `tests/*.mjs` only when a regression exposes a missing assertion
- Modify: Luz-Dev plan through `tech_plan.py mark` and `tech_plan.py sediment`
- Modify: Luz-Crawl experience through `node scripts/luz-crawl.mjs note`

**Interfaces:**
- Consumes: final code and all task commits.
- Produces: complete test evidence, updated plan checklist, and a clean delivery state ready for push/merge.

- [ ] **Step 1: Run focused and full verification**

  ```powershell
  npm test
  node --check lib/social-schema.mjs
  node --check lib/extract-page.mjs
  node --check lib/search.mjs
  node --check lib/capture.mjs
  node scripts/luz-crawl.mjs doctor
  git diff --check
  ```

- [ ] **Step 2: Check the technical plan at delivery stage**

  Mark only verified implementation rules as `done` with command/test evidence; keep unsupported deployment items `planned` or `n/a` with reasons. Then run:

  ```powershell
  python -X utf8 D:\Codes\Luz-Dev\scripts\tech_plan.py check 09 --stage delivery
  ```

  Expected: zero errors. If a requirement changed, run `tech_plan.py revise 09`, update the plan, resubmit and obtain approval before continuing.

- [ ] **Step 3: Record reusable experience**

  ```powershell
  node scripts/luz-crawl.mjs note --kind lesson --key social-search-evidence --text "小红书和抖音检索保留原词并使用有界变体；详情失败继续候选；评论覆盖率只按页面实际加载记录。"
  python -X utf8 D:\Codes\Luz-Dev\scripts\record_experience.py note --kind fact --key social-crawler-search-boundaries --text "公开社媒检索保留原词、拆成有限短语变体、只补搜一轮相关词，并记录详情失败和评论覆盖率。"
  python -X utf8 D:\Codes\Luz-Dev\scripts\tech_plan.py sediment 09 --key social-crawler-search-boundaries,docs-concise
  ```

- [ ] **Step 4: Review the final diff and commit delivery metadata**

  ```powershell
  git status --short
  git diff --stat
  git log --oneline -8
  git diff --check
  git commit --allow-empty -m "chore: record social crawler delivery checks"
  ```

- [ ] **Step 5: Provide delivery summary**

  Report the changed files, test commands and results, the public/login access boundary, and the exact technical-plan HTML path. Do not claim live platform success unless a connected browser run produced evidence.
