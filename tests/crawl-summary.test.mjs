import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../lib/archive.mjs';
import { summaryEntry, writeCrawlSummary } from '../lib/crawl-summary.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'luzcrawl-summary-'));
test.after(()=>fs.rm(tmp,{recursive:true,force:true}));

test('summarizes visible content and candidates without accepting unsafe links',()=>{
  const row=summaryEntry({requested_url:'https://example.com/detail',title:'采购公告',status:'captured',items:[{text:'已取得设备采购正文和供货安装范围。'}],discovered_candidates:3,media:[{kind:'image'},{kind:'audio'}]});
  assert.match(row.summary,/设备采购正文/);
  assert.match(row.summary,/3条候选/);
  assert.match(row.summary,/1张图片、0段视频、1段音频/);
  assert.match(summaryEntry({url:'https://example.com/audio',status:'captured',post:{audios:[{}]}}).summary,/1段音频/);
  for(const url of ['javascript:alert(1)','file:///private','https://user:pass@example.com']) assert.equal(summaryEntry({url}),null);
  const moved=summaryEntry({url:'https://example.com/',status:'completed',results:[{action:'read',value:{url:'https://example.com/',text:'导航前的正文',title:'旧页'}},{action:'click',value:{url:'https://example.com/new',title:'新页'}}]});
  assert.equal(moved.url,'https://example.com/new');
  assert.equal(moved.chars,0);
});

test('rebuilds one task report from nested evidence, deduplicates and shows latest failures',async()=>{
  const root=path.join(tmp,'task');
  await atomicWrite(path.join(root,'raw/luz-task.json'),{schema_version:1,kind:'task_archive',delivery_layout:'task_folder_v2',title:'设备调研'});
  const deep=path.join(root,'raw/0001_集合/sources/web/0001_页面');
  await atomicWrite(path.join(deep,'content.json'),{requested_url:'https://example.com/a',status:'captured',captured_at:'2026-10-25T01:00:00Z',title:'供应商 <script>alert(1)</script>',text:'可公开获取的供货安装需求正文。'});
  await atomicWrite(path.join(root,'raw/tasks/one.json'),{at:'2026-10-25T02:00:00Z',url:'https://example.com/a',result:{status:'captured'}});
  await atomicWrite(path.join(root,'raw/batch-one.json'),{results:[{url:'https://example.com/b',title:'旧公告',text:'历史成功记录不能覆盖新的登录失败。',status:'captured',finished_at:'2026-10-25T01:00:00Z'},{url:'https://example.com/b',status:'awaiting_user',awaiting_reason:'login_required',finished_at:'2026-10-25T03:00:00Z'},{url:'https://example.com/c',status:'skipped'}]});
  await atomicWrite(path.join(root,'raw/snapshots/content.json'),{url:'https://excluded.test/',status:'captured'});
  const results=await Promise.all([writeCrawlSummary(deep),writeCrawlSummary(root)]);
  assert.equal(results[0].file,path.join(root,'task.html'));
  assert.equal(results[1].websites,1);assert.equal(results[1].pages,2);assert.equal(results[1].records,3);
  const html=await fs.readFile(results[1].file,'utf8');
  assert.ok(html.includes("<title>设备调研 爬取总结</title>"));
  assert.match(html,/<main><h1>设备调研 爬取总结<\/h1><section><h2>采集结果<\/h2>/);
  assert.match(html,/<caption>表 1　采集结果<\/caption>/);
  assert(!/<script|kicker|class="stat|class="badge|更新于|LUZCRAWL/.test(html));
  assert.match(html,/供货安装需求正文/);
  assert.match(html,/需要登录/);
  assert(!html.includes('历史成功记录不能'));
  assert(!html.includes('excluded.test'));
  assert(!html.includes('<script>alert(1)</script>'));
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(html.match(/class="title" href="https:\/\/example.com\/a"/g).length,1);
  assert(!html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>|<[^>]+>/g,'').includes('https://'));
  await assert.rejects(()=>fs.access(path.join(root,'参考链接.md')),{code:'ENOENT'});
});

test('a task folder of the older layout (marker beside raw/) is summarized into the file beside raw/ as well',async()=>{
  const root=path.join(tmp,'older','raw','026_旧任务');
  await atomicWrite(path.join(root,'luz-task.json'),{schema_version:1,kind:'task_archive',delivery_layout:'sibling_raw_v1',title:'旧任务'});
  await atomicWrite(path.join(root,'raw/0003_页面/raw/content.json'),{requested_url:'https://example.com/old',status:'captured',captured_at:'2026-10-25T01:00:00Z',title:'旧页面',text:'旧布局存档里的可公开正文内容。'});
  await atomicWrite(path.join(root,'batch-one.json'),{results:[{url:'https://example.com/b',title:'批量页',text:'旧任务根目录下的批量记录正文。',status:'captured',finished_at:'2026-10-25T01:00:00Z'}]});
  const result=await writeCrawlSummary(path.join(root,'raw/0003_页面'));
  assert.equal(result.file,path.join(root,'026_旧任务.html'));
  assert.equal(result.pages,2);
  assert.match(await fs.readFile(result.file,'utf8'),/旧布局存档里的可公开正文内容/);
});

test('a summary can be written from the raw folder of a current task and never lands inside raw/',async()=>{
  for(const name of ['012-主题','013_主题']){   // the current NNN-主题 name and the older underscore name
    const root=path.join(tmp,'fromraw',name);
    await atomicWrite(path.join(root,'raw/luz-task.json'),{schema_version:1,kind:'task_archive',delivery_layout:'task_folder_v2',title:'主题'});
    await atomicWrite(path.join(root,'raw/0001_页面/content.json'),{requested_url:'https://example.com/p',status:'captured',captured_at:'2026-10-25T01:00:00Z',title:'页面',text:'来自任务 raw 目录的正文内容说明。'});
    const result=await writeCrawlSummary(path.join(root,'raw'));
    assert.equal(result.file,path.join(root,`${name}.html`));
    assert.deepEqual((await fs.readdir(root)).sort(),[`${name}.html`,'raw']);
    assert.deepEqual((await fs.readdir(path.join(root,'raw'))).sort(),['0001_页面','luz-task.json']);
  }
});

test('a task without any record gets a page that is only its title; a section is written only when it has content',async()=>{
  const root=path.join(tmp,'empty','001-空任务');
  await atomicWrite(path.join(root,'raw/luz-task.json'),{schema_version:1,kind:'task_archive',delivery_layout:'task_folder_v2',title:'空任务'});
  const empty=await writeCrawlSummary(root);
  assert.equal(empty.records,0);
  const html=await fs.readFile(empty.file,'utf8');
  assert.match(html,/<html lang="zh-CN">/);
  assert.match(html,/<main><h1>空任务 爬取总结<\/h1><\/main>/);
  assert.doesNotMatch(html,/<h2|<table|user-scalable|maximum-scale/);
  await atomicWrite(path.join(root,'raw/batch-bad.json'),{results:[{url:'https://example.com/a',status:'captured',title:'页',text:'有正文的页面内容说明文字。'}]});
  await fs.writeFile(path.join(root,'raw/batch-broken.json'),'{not json');
  const filled=await fs.readFile((await writeCrawlSummary(root)).file,'utf8');
  assert.deepEqual([...filled.matchAll(/<caption>([^<]+)<\/caption>/g)].map(m=>m[1]),['表 1　采集结果','表 2　无法读取的记录']);
  assert.equal(filled.match(/<h1\b/g).length,1);
  assert.equal(filled.match(/<h2>/g).length,2);
});
