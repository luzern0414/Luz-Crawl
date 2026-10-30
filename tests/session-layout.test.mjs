import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allocateRun, atomicWrite, createTaskArchive, deliveryRootForArchive, hash, nameRun, verifyArchive } from '../lib/archive.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-session-layout-'));
process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
test.after(() => fs.rm(root, { recursive: true, force: true }));

test('one session keeps its evidence in one numbered raw folder and delivers HTML beside raw/', async () => {
  const output = path.join(root, 'output');
  const task = await createTaskArchive(output, '搜索主题', { newTask: true });
  assert.equal(path.dirname(task), path.join(output, 'raw'));
  const marker = JSON.parse(await fs.readFile(path.join(task, 'luz-task.json'), 'utf8'));
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.delivery_layout, 'sibling_raw_v1');

  const first = await allocateRun(task, 'https://example.com/1');
  assert.equal(first.output, output);
  assert.equal(first.base, path.join(task, 'raw'));
  assert.equal(await nameRun(first, '来源 1'), '001_来源 1.html');
  assert.equal(first.folder, path.join(task, 'raw', '001_来源 1'));
  assert.equal(await deliveryRootForArchive(first.folder), output);
  await first.release();

  const second = await allocateRun(task, 'https://example.com/2');
  assert.equal(second.serial, 2);
  await second.release();

  const again = await allocateRun(task, 'https://example.com/1');
  assert.equal(again.folder, first.folder);
  assert.equal(again.serial, 1);
  await again.release();
  assert.deepEqual(await fs.readdir(output), ['raw']);
});

test('a delivered HTML beside raw/ is verified and an edited copy is refused', async () => {
  const output = path.join(root, 'verified');
  const task = await createTaskArchive(output, '核验项目');
  const run = await allocateRun(task, 'https://example.com/verified');
  const name = await nameRun(run, '已核验');
  const content = `${JSON.stringify({ requested_url: 'https://example.com/verified', status: 'captured' })}\n`;
  await atomicWrite(path.join(run.folder, 'raw/content.json'), content);
  const html = '<!doctype html><title>已核验</title>\n';
  await atomicWrite(path.join(output, name), html);
  await atomicWrite(path.join(run.folder, 'raw/manifest.json'), { output_layout: 'html_and_raw_v1', status: 'captured', primary_file: name, delivery: { file: name, sha256: hash(html) }, files: [{ path: 'raw/content.json', sha256: hash(content) }] });
  await run.release();
  assert.equal((await verifyArchive(run.folder)).ok, true);
  await fs.appendFile(path.join(output, name), 'edited');
  assert.deepEqual((await verifyArchive(run.folder)).failures, [`delivery:${name}`]);
});
