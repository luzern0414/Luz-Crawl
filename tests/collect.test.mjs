import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, createTaskArchive, hash, verifyArchive } from '../lib/archive.mjs';
import { buildSearchPlan, collect, refreshCollection } from '../lib/collect.mjs';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'luzcrawl-collection-'));
process.env.LUZ_CRAWL_STATE=path.join(temp,'memory');
test.after(()=>fs.rm(temp,{recursive:true,force:true}));

async function source(task,options,extra={}) {
  const url=`https://example.com/${task.platform}`;
  const folder=path.join(options.out,'0001_原文');
  const content={requested_url:url,resolved_url:url,title:'原文',platform:task.platform,status:'captured',url_check:{valid_content:true},items:[{kind:'page_body',text:`${task.platform}原文尾部`}],comments:[{text:'最后一条评论'}]};
  const json=JSON.stringify(content); await atomicWrite(path.join(folder,'content.json'),json);
  await atomicWrite(path.join(folder,'manifest.json'),{files:[{path:'content.json',sha256:hash(json)}]});
  return{folder,status:'captured',browser:{closed:true},...extra};
}

test('plans canonicalize platform aliases and use only confirmed sites for all',async()=>{
  const plan=await buildSearchPlan('Python开源工具',{platform:'GitHub,github,Bing'});
  assert.deepEqual(plan.tasks.map(task=>task.platform),['github','bing']);
  assert.ok(plan.tasks.every(task=>task.query==='Python开源工具'));
  const all=await buildSearchPlan('同一主题',{platform:'all'});
  assert.ok(all.tasks.some(task=>task.platform==='bilibili'));
  assert.ok(!all.tasks.some(task=>task.platform==='qianfan'));
  await assert.rejects(()=>buildSearchPlan('主题',{platform:'missing-platform'}),/Unknown platform/);
});

test('collect exports one ordered HTML with complete source text and comments',async()=>{
  const out=path.join(temp,'complete'); const visited=[];
  const result=await collect('开源工具',{out,platform:'github,bing',read:1},async(task,options)=>{visited.push(task.platform);return source(task,options);});
  assert.deepEqual(visited,['github','bing']);assert.equal(result.status,'captured');assert.equal(result.verified_sources,2);
  assert.equal(result.requested_tasks,2);assert.equal(result.attempted_tasks,2);
  assert.equal(path.dirname(result.html_file),result.folder);
  assert.deepEqual(await fs.readdir(out),[path.basename(result.folder)]);
  const html=await fs.readFile(result.html_file,'utf8');
  assert.ok(html.includes('github原文尾部') && html.includes('bing原文尾部') && html.includes('最后一条评论'));
  assert.ok((await verifyArchive(result.folder)).ok);
  assert.deepEqual((await fs.readdir(result.folder)).sort(),['collection.json','identity.json','manifest.json',path.basename(result.html_file),'sources'].sort());
  assert.equal((await refreshCollection(result.folder)).status,'captured');
  await fs.appendFile(result.html_file,'用户修改');
  await assert.rejects(()=>refreshCollection(result.folder),/edited/);
});

test('missing sources, partial downloads and early cleanup stops remain partial',async()=>{
  const failed=await collect('开源工具',{out:path.join(temp,'failed'),platform:'github,bing'},(task,options)=>task.platform==='bing'?{status:'failed',error:'Invalid URL',browser:{closed:true}}:source(task,options));
  assert.equal(failed.status,'partial');assert.equal(failed.verified_sources,1);assert.equal(failed.attempted_tasks,2);
  const media=await collect('开源工具',{out:path.join(temp,'media'),platform:'github'},(task,options)=>source(task,options,{downloads:{status:'partial',failures:[{error:'HTTP 403'}]}}));
  assert.equal(media.status,'partial');
  const stopped=await collect('开源工具',{out:path.join(temp,'stopped'),platform:'github,bing',concurrency:1},(task,options)=>source(task,options,{browser:{closed:false}}));
  assert.equal(stopped.status,'partial');assert.equal(stopped.attempted_tasks,1);assert.equal(stopped.requested_tasks,2);assert.equal(stopped.browser.closed,false);
});

test('collection overlaps independent sites, leaves affected queued work parked and retains plan order', async () => {
  const file = path.join(temp, 'concurrent-plan.json');
  await atomicWrite(file, [{platform:'github',query:'alpha'},{platform:'github',query:'beta'},{platform:'bing',query:'gamma'}]);
  let active = 0, peak = 0;
  const result = await collect('three routes', {out:path.join(temp,'concurrent'), file, concurrency:2}, async task => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return task.query === 'alpha' ? {status:'awaiting_user',task_id:'saved',awaiting_reason:'verification_required',browser:{closed:true,parked:true}}
      : {status:'failed',error:'offline',browser:{closed:true}};
  });
  assert.equal(peak, 2);
  assert.deepEqual(result.results.map(row => row.query), ['alpha','gamma']);
  assert.equal(result.awaiting_user[0].task_id,'saved');
});

test('report picks up a continued login task without replacing user-edited output',async()=>{
  const initial=await collect('开源工具',{out:path.join(temp,'continued'),platform:'github'},async()=>({status:'awaiting_user',task_id:'manual-task',browser:{closed:true,parked:true}}));
  assert.equal(initial.verified_sources,0);assert.equal(initial.awaiting_user.length,1);
  const out=initial.results[0].out;
  await atomicWrite(path.join(out,'raw/tasks/manual-task.json'),{result:await source({platform:'github'},{out})});
  const refreshed=await refreshCollection(initial.folder);
  assert.equal(refreshed.status,'captured');assert.equal(refreshed.verified_sources,1);assert.equal(refreshed.awaiting_user.length,0);
  assert.equal(refreshed.results[0].resumed_from,'manual-task');assert.ok((await verifyArchive(refreshed.folder)).ok);
});


test('a collection inside a task keeps its report and sources in raw/ and the task summary beside raw/', async () => {
  const output = path.join(temp, 'category-output');
  const task = await createTaskArchive(output, 'one collection request', {newTask: true, threadId: null});
  const result = await collect('browser tooling', {out: task, platform: 'github,bing'}, source);
  assert.equal(path.dirname(result.html_file), result.folder);
  assert.equal(path.dirname(path.dirname(result.folder)), task);
  assert.equal(result.status, 'captured');
  assert.ok((await verifyArchive(result.folder)).ok);
  assert.deepEqual(await fs.readdir(output), [path.basename(task)]);
  assert.deepEqual((await fs.readdir(task)).sort(), [`${path.basename(task)}.html`, 'raw']);
  const summary = await fs.readFile(path.join(task, `${path.basename(task)}.html`), 'utf8');
  assert.ok(summary.includes('github原文尾部') && summary.includes('bing原文尾部'));
  const refreshed = await refreshCollection(result.folder);
  assert.equal(refreshed.html_file, result.html_file);
  assert.equal(refreshed.verified_sources, 2);
  assert.ok((await verifyArchive(result.folder)).ok);
});
