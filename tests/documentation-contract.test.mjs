import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
