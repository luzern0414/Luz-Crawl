import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capture } from '../lib/capture.mjs';
import { batch } from '../lib/batch.mjs';
import { search } from '../lib/search.mjs';
import { createTaskArchive, verifyArchive } from '../lib/archive.mjs';
import { testPolicy } from './helpers.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-crawl-task-layout-'));
process.env.LUZ_CRAWL_STATE = path.join(root, 'state');
delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
test.after(() => fs.rm(root, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../scripts/luz-crawl.mjs', import.meta.url));
const run = promisify(execFile);

// Every file below a folder as forward-slash paths; the contents of snapshots/ are collapsed to one entry.
async function tree(directory, prefix = '') {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.name === 'snapshots') found.push(`${relative}/`);
    else if (entry.isDirectory()) found.push(...await tree(path.join(directory, entry.name), `${relative}/`));
    else found.push(relative);
  }
  return found.sort();
}

function snapshot(url, title, body = 'This is the real page body, with enough content to distinguish it from an empty loading placeholder. '.repeat(3)) {
  return { url, title, text: body, html: `<article>${body}</article>`, presentation: { html: `<article>${body}</article>`, text_chars: body.length, assets: [], width: 598 }, items: [{ id: url, url, kind: 'page_body', text: body }], media: [], links: [], transcript: [], article_links: [], comments: [], post: null, target_present: true, gate: null, loading: false, scroll: { at_bottom: true, height: 1500, top: 500, viewport: 1000 } };
}
function page(url, title) {
  let current = url;
  return { goto: async (target) => { current = target; }, evaluate: async (code) => {
    if (code === 'location.href') return current;
    if (code === '({url:location.href,ready:Boolean(document.body)})') return { url: current, ready: true };
    if (code.includes('function extractPage')) return snapshot(current, title);
    if (code.includes('function expandPage') || code.includes('function dismissLoginGate')) return [];
    if (code.includes('function scrollPage')) return { at_bottom: true, height: 1500, top: 500, viewport: 1000 };
    if (code.includes('element.scrollTo(0, element.scrollHeight)')) return true;
    throw new Error('Unexpected browser operation');
  } };
}
const options = (out, url) => ({ url, out, executionPolicy: testPolicy(root), delay: 0, scrolls: 2, screenshot: false });

// The shared layout check of the Luz skills (scripts/check_output_layout.py): exit 0 = PASS (notes allowed).
const CHECK = fileURLToPath(new URL('../scripts/check_output_layout.py', import.meta.url));
const layoutCheck = (folder) => run('python', ['-X', 'utf8', CHECK, 'session', folder], { encoding: 'utf8' }).then((result) => ({ code: 0, out: result.stdout }), (error) => ({ code: error.code, out: error.stdout }));

test('begin, capture, search, batch and summary all land in the task folder: raw/ holds everything, the summary sits beside it', async () => {
  const output = path.join(root, 'full-chain');
  const begun = JSON.parse((await run(process.execPath, [CLI, 'begin', '目录验证', '--out', output, '--new'], { encoding: 'utf8' })).stdout);
  assert.equal(path.dirname(begun.folder), output);
  assert.equal(path.basename(begun.folder), '001-目录验证');
  const second = JSON.parse((await run(process.execPath, [CLI, 'begin', '另一个需求', '--out', output, '--new'], { encoding: 'utf8' })).stdout);
  assert.equal(path.basename(second.folder), '002-另一个需求');
  const task = begun.folder;
  // A task just begun already passes the layout check: raw/ and the same-named summary page, title first.
  const fresh = await layoutCheck(task);
  assert.equal(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /PASS/);
  assert.doesNotMatch(fresh.out, /^\s+提示 /m);

  const first = await capture(page('https://example.com/a', '第一页'), options(task, 'https://example.com/a'));
  const another = await capture(page('https://example.com/b', '第二页'), options(task, 'https://example.com/b'));
  assert.equal(first.status, 'captured');
  assert.deepEqual([path.basename(first.folder), path.basename(another.folder)], ['0001_第一页', '0002_第二页']);

  const searchResult = await search({}, { platform: 'xhs', query: '目录验证', read: 0, out: task }, { summary: () => ({}) }, async (_page, opts) => {
    const folder = path.join(opts.out, 'raw', '0003_搜索页');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'content.json'), JSON.stringify({ requested_url: opts.url, links: [] }));
    return { folder, status: 'captured', resolved_url: opts.url, url_check: { valid_content: true }, search_action: { submitted: true }, limitations: [] };
  });
  assert.equal(path.dirname(searchResult.search_index), path.join(task, 'raw'));

  const batchFile = path.join(root, 'full-chain-jobs.json');
  await fs.writeFile(batchFile, JSON.stringify(['https://example.com/c']));
  const batched = await batch({ file: batchFile, out: task }, async () => ({ status: 'captured', browser: { owned: true, closed: true } }));
  assert.equal(path.dirname(batched.batch_file), path.join(task, 'raw'));

  const summary = JSON.parse((await run(process.execPath, [CLI, 'summary', task], { encoding: 'utf8' })).stdout);
  assert.equal(summary.file, path.join(task, '001-目录验证.html'));

  // The output root: task folders only. The task: raw/ and the summary. Everything else is inside raw/.
  assert.deepEqual((await fs.readdir(output)).sort(), ['001-目录验证', '002-另一个需求']);
  assert.deepEqual((await fs.readdir(task)).sort(), ['001-目录验证.html', 'raw']);
  const files = await tree(path.join(task, 'raw'));
  assert.ok(files.includes('luz-task.json'));
  assert.ok(files.some((name) => /^batch-.*\.json$/.test(name)));
  assert.ok(files.some((name) => /^search-.*\.json$/.test(name)));
  for (const archive of ['0001_第一页', '0002_第二页']) {
    assert.deepEqual(files.filter((name) => name.startsWith(`${archive}/`)), [`${archive}/${archive}.html`, `${archive}/content.json`, `${archive}/identity.json`, `${archive}/manifest.json`, `${archive}/snapshots/`].sort());
    assert.equal((await verifyArchive(path.join(task, 'raw', archive))).ok, true);
  }
  assert.ok(!files.some((name) => /(^|\/)raw\//.test(name)), 'no nested raw/ anywhere inside raw/');
  const html = await fs.readFile(summary.file, 'utf8');
  assert.ok(html.includes('第一页') && html.includes('第二页'));
  // The finished summary page keeps to the page standard: zh-CN, h1 first and alone, zoom not disabled, one table per h2 section.
  assert.match(html, /<html lang="zh-CN">/);
  assert.equal(html.match(/<h1\b/g).length, 1);
  assert.equal(html.search(/<h[1-6]\b/), html.search(/<h1\b/), 'the first heading is the h1');
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale/i);
  assert.equal(html.match(/<h2>/g).length, html.match(/<table>/g).length);
  const finished = await layoutCheck(task);
  assert.equal(finished.code, 0, finished.out);
  assert.match(finished.out, /PASS/);
});

test('a new task goes after the older underscore tasks, which stay readable, continuable and summarized', async () => {
  const output = path.join(root, 'mixed-output');
  const older = path.join(output, '076_差旅费报销单据要素与审核要点');
  await fs.mkdir(path.join(older, 'raw'), { recursive: true });
  await fs.writeFile(path.join(older, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: '差旅费报销单据要素与审核要点' }));

  const begun = JSON.parse((await run(process.execPath, [CLI, 'begin', '新的调研', '--out', output, '--new'], { encoding: 'utf8' })).stdout);
  assert.equal(path.basename(begun.folder), '077-新的调研');
  assert.deepEqual((await fs.readdir(output)).sort(), ['076_差旅费报销单据要素与审核要点', '077-新的调研']);
  assert.equal((await layoutCheck(begun.folder)).code, 0);

  // The older task takes a capture, is summarized under its own name, and the layout check only notes its old name.
  const captured = await capture(page('https://example.com/older-task', '旧任务里的新页面'), options(older, 'https://example.com/older-task'));
  assert.equal(path.dirname(captured.folder), path.join(older, 'raw'));
  const summary = JSON.parse((await run(process.execPath, [CLI, 'summary', older], { encoding: 'utf8' })).stdout);
  assert.equal(summary.file, path.join(older, '076_差旅费报销单据要素与审核要点.html'));
  assert.deepEqual((await fs.readdir(older)).sort(), ['076_差旅费报销单据要素与审核要点.html', 'raw']);
  const check = await layoutCheck(older);
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /旧格式/);
  // A second begin continues past both.
  const next = JSON.parse((await run(process.execPath, [CLI, 'begin', '再来一项', '--out', output, '--new'], { encoding: 'utf8' })).stdout);
  assert.equal(path.basename(next.folder), '078-再来一项');
});

test('a task folder of the older layout is continued: new pages join its raw/ in the current shape and nothing lands in the output root', async () => {
  const output = path.join(root, 'older-output');
  const task = path.join(output, 'raw', '026_旧任务');
  await fs.mkdir(task, { recursive: true });
  await fs.writeFile(path.join(task, 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: '旧任务' }));
  const captured = await capture(page('https://example.com/older', '旧任务里的新页面'), options(task, 'https://example.com/older'));
  assert.equal(path.dirname(captured.folder), path.join(task, 'raw'));
  assert.equal(path.dirname(captured.html_file), captured.folder);
  assert.equal((await verifyArchive(captured.folder)).ok, true);
  assert.deepEqual(await fs.readdir(output), ['raw']);
  assert.deepEqual((await fs.readdir(task)).sort(), ['026_旧任务.html', 'luz-task.json', 'raw']);
});

test('a new task refuses an output root that still has scattered files, and the CLI says so without moving anything', async () => {
  const output = path.join(root, 'old-root');
  await fs.mkdir(path.join(output, 'raw'), { recursive: true });
  await fs.writeFile(path.join(output, '0001_散落.html'), 'loose');
  const failure = await run(process.execPath, [CLI, 'begin', '新需求', '--out', output, '--new'], { encoding: 'utf8' }).then(() => null, (error) => error);
  assert.ok(failure, 'begin must fail');
  assert.match(failure.stdout, /散落文件/);
  assert.match(failure.stdout, /migrate_layout\.py/);
  assert.deepEqual((await fs.readdir(output)).sort(), ['0001_散落.html', 'raw']);
});
