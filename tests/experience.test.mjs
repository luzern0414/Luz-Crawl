import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lzNote, lzNotes, lzNotesList, lzNotesCheck } from '../lib/notes.mjs';
import { createTaskArchive, findExperience, recordExperience } from '../lib/archive.mjs';
import { lzScope } from '../lib/scope.mjs';
import { siteObservations } from '../lib/site-library.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-experience-'));
process.env.LUZ_CRAWL_STATE = temp;
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('overlapping search completions retain distinct sites and concurrent note confirmations', async () => {
  const folder = await createTaskArchive(path.join(temp, 'concurrent-output'), 'concurrent evidence', {newTask:true,threadId:null});
  const key = 'concurrent-recall';
  await Promise.all(Array.from({length:8}, (_,i) => Promise.all([
    lzScope(folder, [{status:'captured',resolved_url:`https://site${i}.example/doc`,url_check:{valid_content:true}}]),
    lzNote({kind:'lesson',category:'method',key,text:'核验并发结果的正文。'}),
  ])));
  const scope = JSON.parse(await fs.readFile(path.join(temp,'scopes.json'),'utf8'))['concurrent evidence'];
  assert.equal(Object.keys(scope.good).length,8);
  assert.equal((await lzNotesList()).find(row=>row.key===key).uses,8);
});

test('classified notes retain reusable conditions, tags, evidence and outcome', async () => {
  const saved = await lzNote({ key: 'query-decomposition', kind: 'lesson', category: 'keyword',
    text: '检索时分别使用原词和领域术语。', tags: '检索,query,检索', when: '自然语言查询过长',
    source: 'https://example.org/search-method', outcome: 'success', 'valid-until': '2099-01-01', codified: true });
  assert.equal(saved.note.category, 'keyword');
  assert.deepEqual(saved.note.tags, ['检索', 'query']);
  assert.equal(saved.note.when, '自然语言查询过长');
  assert.equal(saved.note.source, 'https://example.org/search-method');
  assert.equal(saved.note.outcome, 'success');
  assert.equal(saved.note.valid_until, '2099-01-01');
  const recalled = (await lzNotesList()).find(n => n.key === saved.note.key);
  assert.equal(recalled.category, 'keyword');
  assert.equal(recalled.codified, true);
});

test('long Chinese requests recall applicable notes without matching the complete sentence', async () => {
  const found = await lzNotes('需要提高检索精度并复用领域术语');
  assert.ok(found.some(n => n.key === 'query-decomposition'));
  await lzNote({ key: 'zebra-unrelated', text: '斑马条纹观察', category: 'method' });
  assert.ok(!(await lzNotes('检索 精度 领域术语')).some(n => n.key === 'zebra-unrelated'));
});

test('category filtering and shared web notes work with platform-specific retrieval', async () => {
  await lzNote({ key: 'web-failure', text: '检索出现空白时先核验查询是否生效。', category: 'failure', platform: 'web', outcome: 'failure' });
  await lzNote({ key: 'github-route', text: '检索仓库先核验原仓库。', category: 'route', platform: 'github' });
  const found = await lzNotes('检索', 'github', { category: 'failure' });
  assert.deepEqual(found.map(n => n.key), ['web-failure']);
});

test('retrieval does not confirm notes and expired evidence remains marked for review', async () => {
  await lzNote({ key: 'expired-source', kind: 'fact', category: 'source', text: '某检索入口的历史核验。', 'valid-until': '2000-01-01' });
  const before = (await lzNotesList()).find(n => n.key === 'expired-source');
  const found = (await lzNotes('检索')).find(n => n.key === 'expired-source');
  assert.equal(found.needs_revalidation, true);
  assert.equal((await lzNotesList()).find(n => n.key === 'expired-source').uses, before.uses);
});

test('invalid classification or sensitive metadata never enters memory', async () => {
  for (const extra of [{ category: 'invented' }, { outcome: 'invented' }, { 'valid-until': '2026-02-31' },
    { tags: 'token=not-for-storage' }, { key: 'cookie=not-for-storage' }, { source: 'https://example.org/?token=secret-value' }]) {
    await assert.rejects(() => lzNote({ key: 'invalid', text: '有效的普通经验', ...extra }));
  }
});

test('related successful and failed events are recalled while unrelated routes stay out', async () => {
  await recordExperience({ platform: 'bing', canonical_url: 'https://www.bing.com/search?q=search',
    query: '检索 领域术语', status: 'captured', valid_content: true, search_performed: true, candidates: 3 });
  await recordExperience({ platform: 'bing', canonical_url: 'https://www.bing.com/search?q=failed',
    query: '领域术语 别名', status: 'blocked', valid_content: false, stop_reason: 'verification_required' });
  const found = await findExperience('检索精度与领域术语复用', 'bing');
  assert.equal(found.events.length, 2);
  assert.ok(!found.route_hints.some(h => h.key === 'douyin-single-video'));
});

test('concurrent updates preserve all observations for a shared source', async () => {
  const observations = 12;
  const event = { platform: 'web', canonical_url: 'https://example.org/accessible-table', query: 'accessible table orchestration',
    status: 'captured', valid_content: true, search_performed: true, candidates: 1 };
  await Promise.all(Array.from({ length: observations }, () => recordExperience(event)));
  const found = await findExperience('accessible table orchestration');
  assert.equal(found.events.find(value => value.canonical_url === event.canonical_url)?.observations, observations);
});

test('source URL corrections remain available even when the original query differs', async () => {
  await recordExperience({ platform: 'github', canonical_url: 'https://github.com/example/repo',
    query: 'old unrelated term', route_kind: 'source_url_correction', validated_url: 'https://github.com/example/repo', status: 'captured' });
  const found = await findExperience('new repository topic', 'github');
  assert.ok(found.events.some(e => e.route_kind === 'source_url_correction'));
});

test('English short tokens do not match a substring in another word', async () => {
  await lzNote({ key: 'next-queries', text: 'Next queries use another keyword.', category: 'keyword' });
  assert.ok(!(await lzNotes('x')).some(n => n.key === 'next-queries'));
});

test('same text in a different category retains separate meaning', async () => {
  await lzNote({ key: 'same-source', kind: 'lesson', text: '本次入口需要复核。', category: 'source' });
  await lzNote({ key: 'same-failure', kind: 'lesson', text: '本次入口需要复核。', category: 'failure' });
  const found = await lzNotesList();
  assert.ok(found.some(n => n.key === 'same-source') && found.some(n => n.key === 'same-failure'));
  assert.equal((await lzNotesCheck()).ok, true);
});

test('automatic crawl scope never promotes captured pages to reviewed sources', async () => {
  const folder = await createTaskArchive(path.join(temp, 'output'), '正文语义复核', { newTask: true });
  await lzScope(folder, [{ status: 'captured', resolved_url: 'https://example.org/video-description', url_check: { valid_content: true } }]);
  const note = (await lzNotes('正文语义复核')).find(n => n.key === 'scope:正文语义复核');
  assert.equal(note.category, 'source');
  assert.equal(note.outcome, 'unverified');
  assert.equal(note.needs_revalidation, true);
  assert.doesNotMatch(note.text, /有效来源/);
  assert.match(note.text, /待语义复核/);
});

test('site capability observations retain the actual index used for a fallback', () => {
  const rows = siteObservations([{ platform: 'gitcn', query: 'browser tools', candidates: [{}], attempts: [
    { url: 'https://gitcn.com/search', status: 'failed', candidates: 0, search_performed: false },
    { url: 'https://www.bing.com/search', status: 'captured', candidates: 1, search_performed: true },
  ] }]);
  assert.deepEqual(rows.map(row => [new URL(row.url).hostname, row.platform, row.candidate_count, row.search_performed]), [
    ['gitcn.com', undefined, 0, false], ['www.bing.com', undefined, 1, true],
  ]);
});
