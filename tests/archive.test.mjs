import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ARCHIVE_LAYOUT, allocateRun, archiveFile, createTaskArchive, findTaskArchive, hash, outputRootOf, verifyArchive } from '../lib/archive.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-archive-'));
process.env.LUZ_CRAWL_STATE = path.join(temp, 'state');
test.after(() => fs.rm(temp, { recursive: true, force: true }));
const exists = (file) => fs.access(file).then(() => true, () => false);

test('a task is a numbered NNN-主题 folder directly under the output root, with raw/, its marker and its summary page', async () => {
  const out = path.join(temp, 'output');
  await fs.mkdir(path.join(out, '003_历史任务'), { recursive: true });
  await fs.mkdir(path.join(out, '004-旧写法'), { recursive: true });

  const first = await createTaskArchive(out, 'xhs_新查询/人工智能', { newTask: true, threadId: null });
  const second = await createTaskArchive(out, 'xhs_新查询/人工智能', { newTask: true, threadId: null });
  assert.equal(path.dirname(first), out);
  assert.equal(path.basename(first), '005-xhs_新查询 人工智能');
  assert.equal(path.basename(second), '006-xhs_新查询 人工智能');

  const marker = JSON.parse(await fs.readFile(path.join(first, 'raw', 'luz-task.json'), 'utf8'));
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.kind, 'task_archive');
  assert.equal(marker.delivery_layout, 'task_folder_v2');
  assert.equal(marker.title, 'xhs_新查询 人工智能');
  // The task root holds raw/ and the same-named summary page, nothing else.
  assert.deepEqual((await fs.readdir(first)).sort(), ['005-xhs_新查询 人工智能.html', 'raw']);
  // The output root holds task folders only: no raw/ of its own, no scattered files, no lock left behind.
  assert.deepEqual((await fs.readdir(out)).sort(), ['003_历史任务', '004-旧写法', '005-xhs_新查询 人工智能', '006-xhs_新查询 人工智能']);
});

test('a new task is numbered after every existing folder, older NNN_主题 ones included, and the older tasks stay usable', async () => {
  const out = path.join(temp, 'mixed-output');
  // An older task written by the previous release: underscore name, marker inside raw/, summary beside raw/.
  const underscored = path.join(out, '076_差旅费报销单据');
  await fs.mkdir(path.join(underscored, 'raw'), { recursive: true });
  await fs.writeFile(path.join(underscored, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: '差旅费报销单据' }));
  // An older task of the oldest shape: marker beside raw/.
  const beside = path.join(out, '110_最早的写法');
  await fs.mkdir(path.join(beside, 'raw'), { recursive: true });
  await fs.writeFile(path.join(beside, 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: '最早的写法' }));
  await fs.mkdir(path.join(out, '000_目录整理记录'), { recursive: true });

  const created = await createTaskArchive(out, '新需求', { newTask: true, threadId: null });
  assert.equal(path.basename(created), '111-新需求');
  assert.equal(path.basename(await createTaskArchive(out, '又一项', { newTask: true, threadId: null })), '112-又一项');

  // The older tasks are found by their marker and take new pages in the current shape; their names are untouched.
  assert.equal((await findTaskArchive(underscored)).folder, underscored);
  assert.equal((await findTaskArchive(path.join(underscored, 'raw'))).folder, underscored);
  assert.equal((await findTaskArchive(beside)).layout, 'sibling_raw_v1');
  const run = await allocateRun(underscored, 'https://example.com/old-task-page');
  try { assert.equal(path.dirname(run.folder), path.join(underscored, 'raw')); } finally { await run.release(); }
  assert.deepEqual((await fs.readdir(out)).sort(), ['000_目录整理记录', '076_差旅费报销单据', '110_最早的写法', '111-新需求', '112-又一项']);
});

test('numbering takes the highest number plus one and never fills a gap', async () => {
  const out = path.join(temp, 'gap-output');
  await fs.mkdir(path.join(out, '001_甲'), { recursive: true });
  await fs.mkdir(path.join(out, '009-乙'), { recursive: true });
  assert.equal(path.basename(await createTaskArchive(out, '丙', { newTask: true, threadId: null })), '010-丙');
});

test('tasks an unmigrated output root still keeps under raw/ count for the next number', async () => {
  const out = path.join(temp, 'unmigrated-output');
  await fs.mkdir(path.join(out, 'raw', '026_旧任务'), { recursive: true });
  await fs.mkdir(path.join(out, 'raw', '0007_页面存档'), { recursive: true });
  assert.equal(path.basename(await createTaskArchive(out, '主题', { newTask: true, threadId: null })), '027-主题');
});

test('concurrent task creation never hands out the same number', async () => {
  const out = path.join(temp, 'concurrent');
  const folders = await Promise.all(Array.from({ length: 5 }, (_, index) => createTaskArchive(out, `请求 ${index}`, { newTask: true, threadId: null })));
  assert.equal(new Set(folders).size, 5);
  assert.deepEqual((await fs.readdir(out)).map((name) => name.slice(0, 3)).sort(), ['001', '002', '003', '004', '005']);
});

test('scattered files in the output root stop task creation and point to the migration script', async () => {
  const out = path.join(temp, 'crowded');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, '0001_散落网页.html'), 'loose');
  await fs.writeFile(path.join(out, '.hidden'), 'ok');
  await fs.writeFile(path.join(out, 'desktop.ini'), 'ok');
  await assert.rejects(() => createTaskArchive(out, '主题', { newTask: true, threadId: null }), (error) => /散落文件/.test(error.message) && error.message.includes('0001_散落网页.html') && /migrate_layout\.py/.test(error.message));
  assert.deepEqual((await fs.readdir(out)).sort(), ['.hidden', '0001_散落网页.html', 'desktop.ini']);
  await fs.rm(path.join(out, '0001_散落网页.html'));
  const folder = await createTaskArchive(out, '主题', { newTask: true, threadId: null });
  assert.equal(path.basename(folder), '001-主题');
});

test('one Codex thread reuses its task archive across repeated and concurrent begin calls', async () => {
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.CODEX_THREAD_ID = 'archive-test-thread';
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'task-state');
  try {
    const out = path.join(temp, 'task-output');
    const [first, concurrent] = await Promise.all([
      createTaskArchive(out, 'request title'),
      createTaskArchive(out, 'request title')
    ]);
    const repeated = await createTaskArchive(out, 'different keyword');
    const next = await createTaskArchive(out, 'new request', { newTask: true });
    const resumed = await createTaskArchive(out, 'new request');
    const folders = await fs.readdir(out, { withFileTypes: true });

    assert.equal(first, concurrent);
    assert.equal(first, repeated);
    assert.equal(next, resumed);
    assert.notEqual(first, next);
    assert.equal(path.dirname(first), out);
    assert.ok(folders.length === 2 && folders.every((entry) => entry.isDirectory()));
    assert.equal(JSON.parse(await fs.readFile(path.join(first, 'raw', 'luz-task.json'), 'utf8')).thread_id, 'archive-test-thread');
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});

test('different conversations and projects stay isolated while each binding is reusable', async () => {
  const previousThread = process.env.CODEX_THREAD_ID;
  const previousState = process.env.LUZ_CRAWL_STATE;
  process.env.LUZ_CRAWL_STATE = path.join(temp, 'shared-task-state');
  try {
    const out = path.join(temp, 'shared-task-output');
    process.env.CODEX_THREAD_ID = 'coordinator-thread';
    const task = await createTaskArchive(out, 'user request');
    process.env.CODEX_THREAD_ID = 'worker-thread-a';
    const workerA = await createTaskArchive(out, 'keyword A');
    process.env.CODEX_THREAD_ID = 'worker-thread-b';
    const workerB = await createTaskArchive(out, 'keyword B');

    assert.notEqual(workerA, task);
    assert.notEqual(workerB, task);
    assert.notEqual(workerA, workerB);

    process.env.CODEX_THREAD_ID = 'coordinator-thread';
    const nextTask = await createTaskArchive(out, 'next user request', { newTask: true });
    assert.equal(await createTaskArchive(out, 'same user request'), nextTask);
    process.env.CODEX_THREAD_ID = 'worker-thread-c';
    const workerC = await createTaskArchive(out, 'another keyword');
    assert.equal(await createTaskArchive(out, 'another keyword again'), workerC);
    const folders = await fs.readdir(out, { withFileTypes: true });

    assert.notEqual(nextTask, task);
    assert.notEqual(workerC, nextTask);
    assert.equal(folders.length, 5);
    // One binding per conversation: switching projects rebinds the thread, so returning starts a new task folder.
    const otherProject = await createTaskArchive(path.join(temp, 'second-project'), 'same query');
    assert.notEqual(otherProject, workerC);
    const returned = await createTaskArchive(out, 'return to first project');
    assert.notEqual(returned, workerC);
    assert.equal(path.dirname(returned), out);
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});

test('a task is found from its folder, from its raw/ folder and from the older marker beside raw/', async () => {
  const out = path.join(temp, 'find-output');
  const task = await createTaskArchive(out, '查找', { newTask: true, threadId: null });
  const found = await findTaskArchive(task);
  assert.equal(found.folder, task);
  assert.equal(found.layout, 'task_folder_v2');
  assert.equal((await findTaskArchive(path.join(task, 'raw'))).folder, task);
  assert.equal(outputRootOf(found), out);
  assert.equal(await findTaskArchive(out), null);
  assert.equal(await findTaskArchive(path.join(temp, 'does-not-exist')), null);

  // Older task folder: marker beside its raw/, delivery_layout sibling_raw_v1, tasks listed under <root>\raw\.
  const legacy = path.join(temp, 'legacy-output', 'raw', '026_旧任务');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: '旧任务' }));
  const older = await findTaskArchive(legacy);
  assert.equal(older.folder, legacy);
  assert.equal(older.layout, 'sibling_raw_v1');
  assert.equal(older.title, '旧任务');
  assert.equal(outputRootOf(older), path.join(temp, 'legacy-output'));
});

test('archive files are found in the archive itself first, then in its raw/ child', async () => {
  const flat = path.join(temp, 'flat-archive');
  const older = path.join(temp, 'older-archive');
  await fs.mkdir(path.join(older, 'raw'), { recursive: true });
  await fs.mkdir(flat, { recursive: true });
  await fs.writeFile(path.join(flat, 'content.json'), '{}');
  await fs.writeFile(path.join(older, 'raw', 'content.json'), '{}');
  assert.equal(await archiveFile(flat, 'content.json'), path.join(flat, 'content.json'));
  assert.equal(await archiveFile(older, 'content.json'), path.join(older, 'raw', 'content.json'));
  assert.equal(await archiveFile(flat, 'downloads.json'), path.join(flat, 'downloads.json'));
});

test('an archive keeps its HTML inside and refuses an edited copy', async () => {
  const archive = path.join(temp, 'v2-archive', '0001_post');
  await fs.mkdir(archive, { recursive: true });
  const content = '{"requested_url":"https://example.com/post"}\n';
  const html = '<!doctype html><title>post</title>\n';
  await fs.writeFile(path.join(archive, 'content.json'), content);
  await fs.writeFile(path.join(archive, '0001_post.html'), html);
  await fs.writeFile(path.join(archive, 'manifest.json'), JSON.stringify({
    output_layout: ARCHIVE_LAYOUT, status: 'captured', primary_file: '0001_post.html',
    files: [{ path: 'content.json', sha256: hash(content) }, { path: '0001_post.html', sha256: hash(html) }]
  }));
  assert.deepEqual(await verifyArchive(archive), { ok: true, failures: [], status: 'captured', completeness: undefined });
  await fs.appendFile(path.join(archive, '0001_post.html'), 'edited');
  assert.deepEqual((await verifyArchive(archive)).failures, ['0001_post.html']);
  await fs.writeFile(path.join(archive, 'manifest.json'), JSON.stringify({ output_layout: ARCHIVE_LAYOUT, primary_file: 'missing.html', files: [{ path: 'content.json', sha256: hash(content) }] }));
  assert.deepEqual((await verifyArchive(archive)).failures, ['html:missing.html']);
});

test('verified delivery of an older archive stays valid after all raw files are pruned and hashed in the manifest', async () => {
  const out = path.join(temp, 'compacted-output');
  const archive = path.join(out, 'raw', '001_post');
  await fs.mkdir(path.join(archive, 'raw'), { recursive: true });
  const delivery = path.join(out, '001_post.html');
  await fs.writeFile(delivery, 'verified');
  await fs.writeFile(path.join(archive, 'raw', 'manifest.json'), JSON.stringify({
    output_layout: 'html_and_raw_v1', status: 'captured', primary_file: '001_post.html',
    delivery: { file: '001_post.html', sha256: hash(await fs.readFile(delivery)) },
    files: [], pruned_files: [{ path: 'raw/content.json', bytes: 1234, sha256: 'a'.repeat(64) }]
  }));

  assert.deepEqual(await verifyArchive(archive), { ok: true, failures: [], status: 'captured', completeness: undefined });
  assert.equal(await exists(path.join(out, 'raw', 'raw')), false);
});
