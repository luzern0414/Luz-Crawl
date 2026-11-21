import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLiveServer } from '../lib/live-server.mjs';
import { createLiveController } from '../lib/live-controller.mjs';
import { actionArgument } from './helpers.mjs';
import { requireLiveExtension } from '../lib/live.mjs';

test('live refuses a stale connected extension before creating or interacting with a page',()=>{
  const status=version=>({profiles:[{contextId:'owned',extensionConnected:true,extensionVersion:version}]});
  assert.throws(()=>requireLiveExtension(status('3.5.0'),'owned'),{code:'extension_update_required'});
  assert.throws(()=>requireLiveExtension(status('3.6.0'),'another'),{code:'extension_update_required'});
  assert.throws(()=>requireLiveExtension(null,'owned'),{code:'extension_update_required'});
  assert.doesNotThrow(()=>requireLiveExtension(status('3.6.0'),'owned'));
});

test('authenticated live requests are deduplicated, serialized and durably recorded without input values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-live-server-'));
  let calls = 0, unblock;
  const server = await createLiveServer({
    directory, token: 'test-secret', session: 'test-session', out: directory, ttl: 60,
    dispatch: async message => { calls++; if (message.op === 'slow') await new Promise(resolve => { unblock = resolve; }); return { status: 'completed' }; },
    status: () => ({ status: 'ready' }),
  });
  const request = async (id, op = 'act', token = 'test-secret') => {
    const response = await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, op, session:'test-session', out:directory, text:'private typed value' }) });
    return { status:response.status, body:await response.json() };
  };
  try {
    assert.equal((await request('one', 'act', 'wrong')).status, 401);
    assert.equal((await request('one')).status, 200);
    assert.equal((await request('one')).body.replayed, true);
    assert.equal(calls, 1);
    assert.equal((await request('one', 'different')).status, 409);
    const slow = request('two', 'slow');
    while (!unblock) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request('three')).status, 409);
    assert.equal((await request('four')).status, 409);
    unblock(); await slow;
    assert.equal(calls, 2);
    const logs = await fs.readdir(directory);
    const content = (await Promise.all(logs.filter(n => n.endsWith('.json')).map(n => fs.readFile(path.join(directory,n),'utf8')))).join('');
    assert.ok(content.includes('completed'));
    assert.ok(!content.includes('private typed value'));
    assert.ok(!content.includes('test-secret'));
  } finally { await server.close(); await fs.rm(directory,{recursive:true,force:true}); }
});

test('live resolves a changed identifier in the same lease and reports a closed task tab', async () => {
  const url = 'https://example.com/';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'luz-live-page-'));
  let active = 'stale-target';
  let tabs = [{page: 'current-target', url}];
  const reads = [];
  const page = {
    getActivePage: () => active,
    setActivePage: target => { active = target; },
    tabs: async () => tabs,
    goto: () => assert.fail('A live inspection must not navigate to recover a tab.'),
    evaluate: async () => {
      reads.push(active);
      if (active !== tabs[0]?.page || !tabs.length) throw new Error(`Page not found: ${active} — stale page identity`);
      return {ok:true,url,title:'Live fixture',text:'Owned page'};
    },
  };
  const controller = createLiveController(page,{id:'test',out:directory,url});
  try {
    const result = await controller.dispatch({id:'one',op:'inspect'});
    assert.equal(result.status,'completed');
    assert.deepEqual(reads,['stale-target','current-target','current-target']);
    tabs = [];
    await assert.rejects(() => controller.dispatch({id:'two',op:'inspect'}),{code:'live_page_closed'});
    assert.equal(controller.status().status,'page_closed');
    assert.equal(controller.status().page,undefined);
    await assert.rejects(() => controller.dispatch({id:'three',op:'navigate',options:{url}}),{code:'live_page_closed'});
    assert.equal((await controller.dispatch({id:'four',op:'close'})).status,'closing');
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('an interrupted form blocks later writes, navigation and capture until its original condition is observed', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'luz-live-pending-'));
  const previous=process.env.LUZ_CRAWL_STATE;process.env.LUZ_CRAWL_STATE=directory;
  let writes=0,satisfied=false;
  const page={evaluate:async code=>{
    if(!code.includes('function domOperation'))return {url:'https://example.com/',title:'fixture'};
    const step=actionArgument(code);
    if(step.action==='form'){writes++;return {ok:false,url:'https://example.com/',error:{code:'target_disabled',message:'second field detached',outcome_unknown:true}};}
    return {ok:true,url:'https://example.com/',satisfied,text:'observed'};
  }};
  const controller=createLiveController(page,{id:'test',out:directory,url:'https://example.com/'});
  const expect={selector:'#done',text:'saved',timeout_ms:1};
  const call=(id,op,options={})=>controller.dispatch({id,op,options});
  try {
    const result=await call('write-1','act',{allowWrite:true,steps:[{action:'form',selector:'#f',fields:[{selector:'#a',value:'x'}],expect}]});
    assert.equal(result.live.pending_verification.request_id,'write-1');
    await assert.rejects(()=>call('write-2','act',{allowWrite:true,steps:[{action:'click',selector:'#b'}]}),{code:'write_outcome_unknown'});
    await assert.rejects(()=>call('nav','navigate',{url:'https://example.com/next'}),{code:'write_outcome_unknown'});
    await assert.rejects(()=>call('capture','capture'),{code:'write_outcome_unknown'});
    await call('read','inspect');assert.equal(writes,1);
    await assert.rejects(()=>call('verify','verify',{pending_id:'other',expect,note:'observed'}),{code:'invalid_verification'});
    await assert.rejects(()=>call('verify','verify',{pending_id:'write-1',expect:{selector:'body'},note:'observed'}),{code:'invalid_verification'});
    satisfied=true;assert.equal((await call('verify','verify',{pending_id:'write-1',note:'The intended saved marker is visible.'})).status,'verified');
    assert.equal(controller.status().pending_verification,null);
  } finally { if(previous===undefined)delete process.env.LUZ_CRAWL_STATE;else process.env.LUZ_CRAWL_STATE=previous;await fs.rm(directory,{recursive:true,force:true}); }
});
