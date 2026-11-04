import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));

test('skill instructions describe social search routes and evidence rules', async () => {
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /小红书|xhs/);
  assert.match(skill, /抖音|douyin/);
  assert.match(skill, /GitCN/);
  assert.match(skill, /评论/);
  assert.match(skill, /公开页面/);
  assert.match(skill, /详情/);
});

async function markdownFiles(directory = root) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['data', 'node_modules', 'browser-extension', '.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(file));
    else if (entry.name.endsWith('.md')) found.push(file);
  }
  return found;
}

test('every command and option the docs show exists in the CLI', async () => {
  const usage = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(root, 'scripts', 'luz-crawl.mjs'), '--help'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const preflight = await new Promise((resolve, reject) => execFile('python', ['-X', 'utf8', path.join(root, 'scripts', 'crawl_preflight.py'), 'run', '--help'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const missing = [];
  for (const file of await markdownFiles()) {
    const text = await fs.readFile(file, 'utf8');
    for (const [, command] of text.matchAll(/luz-crawl\.mjs\s+([a-z][a-z-]*)/g)) if (!new RegExp(`luz-crawl\\.mjs ${command}\\b`).test(usage)) missing.push(`${path.relative(root, file)}: ${command}`);
    for (const [, flag] of text.matchAll(/crawl_preflight\.py[^\n`]*?\s(--[a-z]+)/g)) if (!preflight.includes(flag)) missing.push(`${path.relative(root, file)}: ${flag}`);
  }
  assert.deepEqual(missing, []);
});

test('relative links in the markdown docs point at files that exist', async () => {
  const broken = [];
  for (const file of await markdownFiles()) {
    const text = await fs.readFile(file, 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      // Links into a sibling Luz skill resolve only when that skill sits next to this one.
      const exists = (target) => fs.access(target).then(() => true, () => false);
      if (path.relative(root, resolved).startsWith('..') && !(await exists(path.resolve(root, '..', 'Luz-Project')))) continue;
      if (!(await exists(resolved))) broken.push(`${path.relative(root, file)}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('the conclusion page and summary share one font stack and the Markdown type block', async () => {
  const css = (await fs.readFile(path.join(root, 'lib', 'formal-report.css'), 'utf8')).replace(/\r\n/g, '\n');
  const block = css.match(/\/\* luz-md-type:start[\s\S]*?\/\* luz-md-type:end \*\//);
  assert.ok(block, 'the stylesheet carries the luz-md-type block');
  // Phone first, then desktop from 768: body 16 and 18, h1 28 and 36, h2 24 and 28, tables 14 and 16.
  assert.match(block[0], /:root \{\s*--md-body: 16px;[^}]*--md-h1: 28px;\s*--md-h2: 24px;[^}]*--md-table: 14px;/);
  assert.match(block[0], /@media \(min-width: 768px\) \{\s*:root \{\s*--md-body: 18px;[^}]*--md-h1: 36px;\s*--md-h2: 28px;[^}]*--md-table: 16px;/);
  const rest = css.replace(block[0], '');
  // Outside the block: one text face on body, no size, line height or font shorthand of its own, no decoration.
  assert.equal((rest.match(/font-family:/g) || []).length, 1);
  assert.doesNotMatch(rest, /font:|font-size:|line-height:/);
  assert.deepEqual([...new Set(css.match(/font-weight:\s*\d+/g).map((value) => value.replace(/\D/g, '')))].sort(), ['400', '600', '700']);
  assert.doesNotMatch(css, /italic|oblique/);
  assert.doesNotMatch(rest, /box-shadow|border-radius|gradient/);
  // Next to a checkout of the shared master, the block is the master byte for byte.
  const master = await fs.readFile(path.join(root, '..', 'Luz-Design', 'references', 'md-type.css'), 'utf8').catch(() => '');
  const copy = master.replace(/\r\n/g, '\n').match(/\/\* luz-md-type:start[\s\S]*?\/\* luz-md-type:end \*\//);
  if (copy) assert.equal(block[0], copy[0]);
});

test('user-facing docs stay focused on function, purpose and operation', async () => {
  const [readme, help] = await Promise.all([
    fs.readFile(path.join(root, 'README.md'), 'utf8'),
    fs.readFile(path.join(root, 'browser-extension', 'help.html'), 'utf8'),
  ]);
  for (const text of [readme, help]) {
    assert.match(text, /功能|作用/);
    assert.match(text, /操作|使用/);
    assert.doesNotMatch(text, /作者：|作者单位|Author:|来源统计|调研来源/);
  }
});

test('the docs describe one output layout: 序号_主题 task folders holding raw/ and the summary html', async () => {
  for (const name of ['SKILL.md', 'README.md', path.join('references', 'evidence.md'), path.join('references', 'workflows.md')]) {
    const text = await fs.readFile(path.join(root, name), 'utf8');
    assert.match(text, /序号_主题|NNN_主题/, name);
    assert.match(text, /raw/, name);
    assert.doesNotMatch(text, /三层|sibling_raw|raw[\/]NNN|raw[\/]爬取总结|散落文件归档/, name);
  }
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /migrate_layout\.py/);
  assert.match(skill, /085_主题\.html/);
});
