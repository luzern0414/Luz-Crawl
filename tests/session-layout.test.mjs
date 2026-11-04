import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ARCHIVE_LAYOUT, allocateRun, atomicWrite, createTaskArchive, hash, legacyDeliveryRoot, nameRun, verifyArchive } from '../lib/archive.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-session-layout-'));
process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
test.after(() => fs.rm(root, { recursive: true, force: true }));

test('one task keeps its pages in task/raw/NNNN_标题 and its summary beside raw/', async () => {
  const output = path.join(root, 'output');
  const task = await createTaskArchive(output, '搜索主题', { newTask: true, threadId: null });
  assert.equal(path.dirname(task), output);

  const first = await allocateRun(task, 'https://example.com/1');
  assert.equal(first.base, path.join(task, 'raw'));
  assert.equal(first.prefix, '');
  assert.equal(first.legacyOutput, null);
  assert.equal(await nameRun(first, '来源 1'), '0001_来源 1.html');
  assert.equal(first.folder, path.join(task, 'raw', '0001_来源 1'));
  await first.release();

  const second = await allocateRun(task, 'https://example.com/2');
  assert.equal(second.serial, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(second.folder, 'identity.json'), 'utf8')), { canonical_url: 'https://example.com/2', serial: 2 });
  await second.release();

  // The same URL again never reuses the archive it already has: a new serial, and the old folder is left alone.
  const again = await allocateRun(task, 'https://example.com/1');
  assert.notEqual(again.folder, first.folder);
  assert.equal(again.serial, 3);
  assert.equal(again.recaptureOf, '0001_来源 1');
  assert.equal(JSON.parse(await fs.readFile(path.join(again.folder, 'identity.json'), 'utf8')).recapture_of, '0001_来源 1');
  await again.release();
  // Only an explicit resume continues one, the newest of that URL.
  const resumed = await allocateRun(task, 'https://example.com/1', true);
  assert.equal(resumed.folder, again.folder);
  assert.equal(resumed.recaptureOf, null);
  await resumed.release();
  // Nothing but the task folder in the output root; nothing but raw/ in the task before the summary is written.
  assert.deepEqual(await fs.readdir(output), [path.basename(task)]);
  assert.deepEqual(await fs.readdir(task), ['raw']);
});

test('page serials keep counting up across the tasks of one output root', async () => {
  const output = path.join(root, 'serials');
  const one = await createTaskArchive(output, '第一个任务', { newTask: true, threadId: null });
  const two = await createTaskArchive(output, '第二个任务', { newTask: true, threadId: null });
  const a = await allocateRun(one, 'https://example.com/a');
  const b = await allocateRun(two, 'https://example.com/b');
  const c = await allocateRun(one, 'https://example.com/c');
  assert.deepEqual([a.serial, b.serial, c.serial], [1, 2, 3]);
  assert.equal(path.basename(b.folder), '0002_未命名网页');
  assert.equal(path.dirname(b.folder), path.join(two, 'raw'));
  for (const run of [a, b, c]) await run.release();
  // Both tasks allocating at the same moment still get different numbers.
  const runs = await Promise.all([allocateRun(one, 'https://example.com/d'), allocateRun(two, 'https://example.com/e'), allocateRun(one, 'https://example.com/f')]);
  assert.equal(new Set(runs.map((run) => run.serial)).size, 3);
  for (const run of runs) await run.release();
});

test('a folder that is not a task holds its archives directly', async () => {
  const folder = path.join(root, 'plain');
  const run = await allocateRun(folder, 'https://example.com/plain');
  assert.equal(run.base, folder);
  assert.equal(run.task, null);
  assert.equal(path.dirname(run.folder), folder);
  assert.equal(await nameRun(run, '独立页面'), '0001_独立页面.html');
  await run.release();
  assert.deepEqual(await fs.readdir(folder), ['0001_独立页面']);
});

test('a task page verifies with its HTML inside and an edited copy is refused', async () => {
  const output = path.join(root, 'verified');
  const task = await createTaskArchive(output, '核验项目', { newTask: true, threadId: null });
  const run = await allocateRun(task, 'https://example.com/verified');
  const name = await nameRun(run, '已核验');
  const content = `${JSON.stringify({ requested_url: 'https://example.com/verified', status: 'captured' })}\n`;
  const html = '<!doctype html><title>已核验</title>\n';
  await atomicWrite(path.join(run.folder, 'content.json'), content);
  await atomicWrite(path.join(run.folder, name), html);
  await atomicWrite(path.join(run.folder, 'manifest.json'), { output_layout: ARCHIVE_LAYOUT, status: 'captured', primary_file: name, files: [{ path: 'content.json', sha256: hash(content) }, { path: name, sha256: hash(html) }] });
  await run.release();
  assert.equal((await verifyArchive(run.folder)).ok, true);
  await fs.appendFile(path.join(run.folder, name), 'edited');
  assert.deepEqual((await verifyArchive(run.folder)).failures, [name]);
});

test('a task folder of the older layout is continued in place: its archives keep their raw/ and their HTML stays in the delivery folder', async () => {
  const output = path.join(root, 'older');
  const task = path.join(output, 'raw', '001_旧任务');
  await fs.mkdir(task, { recursive: true });
  await fs.writeFile(path.join(task, 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: '旧任务' }));
  // An archive written by the older layout: files under <archive>\raw\, the HTML beside the output root's raw\.
  const archive = path.join(task, 'raw', '0007_旧页面');
  await fs.mkdir(path.join(archive, 'raw'), { recursive: true });
  const content = '{"requested_url":"https://example.com/old","status":"captured"}\n';
  const html = '<!doctype html><title>旧页面</title>\n';
  await fs.writeFile(path.join(archive, 'raw', 'content.json'), content);
  await fs.writeFile(path.join(output, '0007_旧页面.html'), html);
  await fs.writeFile(path.join(archive, 'raw', 'identity.json'), JSON.stringify({ canonical_url: 'https://example.com/old', serial: 7 }));
  await fs.writeFile(path.join(archive, 'raw', 'manifest.json'), JSON.stringify({
    output_layout: 'html_and_raw_v1', status: 'captured', canonical_url: 'https://example.com/old', primary_file: '0007_旧页面.html',
    delivery: { file: '0007_旧页面.html', sha256: hash(html) }, files: [{ path: 'raw/content.json', sha256: hash(content) }]
  }));
  assert.equal(await legacyDeliveryRoot(archive), output);
  assert.equal((await verifyArchive(archive)).ok, true);

  const resumed = await allocateRun(task, 'https://example.com/old', true);
  assert.equal(resumed.folder, archive);
  assert.equal(resumed.serial, 7);
  assert.equal(resumed.prefix, 'raw/');
  assert.equal(resumed.legacyOutput, output);
  assert.equal(resumed.previous.output_layout, 'html_and_raw_v1');
  await resumed.release();

  // Without --resume the same URL becomes a new archive in the current layout, numbered after the older one.
  const recapture = await allocateRun(task, 'https://example.com/old');
  assert.equal(recapture.prefix, '');
  assert.equal(recapture.recaptureOf, '0007_旧页面');
  assert.equal(recapture.serial, 8);
  assert.equal(recapture.base, path.join(task, 'raw'));
  await recapture.release();
  assert.equal((await verifyArchive(archive)).ok, true);
});
