import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocateArchiveDirectory, createTaskArchive, hash, rawRootFor, verifyArchive } from '../lib/archive.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-archive-'));
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('search archive allocation creates unique numbered child directories and files loose files away', async () => {
  const out = path.join(temp, 'output');
  const raw = path.join(out, 'raw');
  await fs.mkdir(path.join(raw, '003_历史材料'), { recursive: true });
  await fs.writeFile(path.join(raw, '遗留.html'), 'legacy');

  const first = await allocateArchiveDirectory(out, 'xhs_新查询/人工智能');
  const second = await allocateArchiveDirectory(out, 'xhs_新查询/人工智能');
  assert.equal(await fs.readFile(path.join(raw, '004_散落文件归档', '遗留.html'), 'utf8'), 'legacy');
  assert.equal(path.dirname(first), raw);
  assert.equal(path.basename(first), '005_xhs_新查询 人工智能');
  assert.equal(path.basename(second), '006_xhs_新查询 人工智能');
  assert.deepEqual((await fs.readdir(raw, { withFileTypes: true })).filter((entry) => !entry.isDirectory()).map((entry) => entry.name), []);
  assert.equal(rawRootFor(out), raw);

  const configuredRawRoot = path.join(temp, 'explicit', 'raw');
  const direct = await allocateArchiveDirectory(configuredRawRoot, 'search_xhs_第三个查询');
  assert.equal(path.dirname(direct), configuredRawRoot);
  assert.equal(rawRootFor(configuredRawRoot), configuredRawRoot);
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
    const folders = await fs.readdir(path.join(out, 'raw'), { withFileTypes: true });

    assert.equal(first, concurrent);
    assert.equal(first, repeated);
    assert.equal(next, resumed);
    assert.notEqual(first, next);
    assert.equal(path.dirname(first), path.join(out, 'raw'));
    assert.ok(folders.length === 2 && folders.every((entry) => entry.isDirectory()));
    assert.equal(JSON.parse(await fs.readFile(path.join(first, 'luz-task.json'), 'utf8')).thread_id, 'archive-test-thread');
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
    const folders = await fs.readdir(path.join(out, 'raw'), { withFileTypes: true });

    assert.notEqual(nextTask, task);
    assert.notEqual(workerC, nextTask);
    assert.equal(folders.length, 5);
    // One binding per conversation: switching projects rebinds the thread, so returning starts a new task folder.
    const otherProject = await createTaskArchive(path.join(temp, 'second-project'), 'same query');
    assert.notEqual(otherProject, workerC);
    const returned = await createTaskArchive(out, 'return to first project');
    assert.notEqual(returned, workerC);
    assert.equal(path.dirname(returned), path.join(out, 'raw'));
  } finally {
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    if (previousState === undefined) delete process.env.LUZ_CRAWL_STATE;
    else process.env.LUZ_CRAWL_STATE = previousState;
  }
});

test('verified delivery stays valid after all raw files are pruned and hashed in the manifest', async () => {
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
});
