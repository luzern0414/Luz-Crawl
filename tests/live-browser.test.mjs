import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTaskArchive } from '../lib/archive.mjs';
import { startLive, requestLive, liveFile, liveRoot } from '../lib/live.mjs';
import { edgeAvailable } from './edge-page.mjs';

test('a live browser keeps form state across CLI processes, deduplicates writes, verifies uncertain effects and closes', {skip:!edgeAvailable}, async () => {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'luz-live-e2e-'));
  const previous={state:process.env.LUZ_CRAWL_STATE,profiles:process.env.LUZ_CRAWL_PROFILES};
  process.env.LUZ_CRAWL_STATE=path.join(tmp,'state');process.env.LUZ_CRAWL_PROFILES=path.join(tmp,'profiles');
  const runtimeRoot=liveRoot();
  const fixture=http.createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<title>Live Fixture</title><h1>Browser state fixture</h1><p>This local page tests serial browser actions and persistent form state.</p><form id="f"><input id="q"><select id="select"><option value="a">A</option><option value="b">B</option></select><input id="check" type="checkbox"><button id="submit">Send</button></form><button id="uncertain">Delayed</button><output id="count">0</output><p id="status">idle</p><script>let n=0;document.querySelector('#f').onsubmit=e=>{e.preventDefault();document.querySelector('#count').textContent=++n;document.querySelector('#status').textContent=document.querySelector('#q').value};document.querySelector('#uncertain').onclick=()=>{document.querySelector('#count').textContent=++n;setTimeout(()=>document.querySelector('#status').textContent='settled',1200)};</script>`);});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  let session,out;
  const metrics=[];
  async function cli(op,extra=[],expected=0) {
    const started=Date.now();let output,code=0;
    try {output=(await promisify(execFile)(process.execPath,['scripts/luz-crawl.mjs','live',op,session,'--out',out,...extra],{cwd:new URL('..',import.meta.url),windowsHide:true,timeout:90000,maxBuffer:4000000})).stdout;}
    catch(error){code=error.code;output=error.stdout;}
    assert.equal(code,expected,output);const result=JSON.parse(output);metrics.push({op,cli_ms:Date.now()-started,operation_ms:result.elapsed_ms});return result;
  }
  try {
    out=await createTaskArchive(path.join(tmp,'output'),'live-fixture',{newTask:true});
    const opened=await startLive({out,url:`http://127.0.0.1:${fixture.address().port}/`,ttl:120});session=opened.session;
    assert.equal(opened.status,'ready');metrics.push({op:'open',cli_ms:opened.open_elapsed_ms});
    const steps=[{action:'type',selector:'#q',text:'状态保留',method:'native'},{action:'select',selector:'#select',values:['b']},{action:'check',selector:'#check',checked:true}];
    const file=path.join(out,'raw','actions.json');await fs.writeFile(file,JSON.stringify(steps));
    assert.equal((await cli('act',['--file',file,'--allow-write','--request-id','fill-1'])).status,'completed');
    const snapshot=await cli('inspect');assert.ok(snapshot.results[0].value.controls.some(c=>c.selector==='#q'));
    await fs.writeFile(file,JSON.stringify([{action:'submit',selector:'#f',expect:{selector:'#status',text_equals:'状态保留'}}]));
    assert.equal((await cli('act',['--file',file,'--allow-write','--request-id','submit-1'])).status,'completed');
    assert.equal((await cli('act',['--file',file,'--allow-write','--request-id','submit-1'])).replayed,true);
    const expect={selector:'#status',text_equals:'settled',timeout_ms:1};
    await fs.writeFile(file,JSON.stringify([{action:'click',selector:'#uncertain',expect}]));
    const uncertain=await cli('act',['--file',file,'--allow-write','--request-id','delayed-1'],2);
    assert.equal(uncertain.live.pending_verification.request_id,'delayed-1');
    await cli('act',['--file',file,'--allow-write','--request-id','do-not-replay'],2);
    const readFile=path.join(out,'raw','read.json');await fs.writeFile(readFile,JSON.stringify([{action:'read',selector:'#count'}]));
    assert.equal((await cli('inspect',['--file',readFile])).results[0].value.text,'2');
    const verification=path.join(out,'raw','verify.json');await fs.writeFile(verification,JSON.stringify({pending_id:'delayed-1',note:'The delayed status establishes the expected effect; the click count remains two.',expect}));
    await new Promise(r=>setTimeout(r,1300));
    assert.equal((await cli('verify',['--file',verification])).status,'verified');
    const saved=await cli('capture',['--scrolls','0','--no-screenshot']);assert.ok(saved.folder);assert.ok(['captured','partial'].includes(saved.status));
    const closed=await cli('close');assert.equal(closed.status,'closed');assert.equal(closed.cleanup.owned_page_closed,true);
    const runtime=JSON.parse(await fs.readFile(liveFile(session),'utf8'));assert.equal(runtime.token,undefined);
    if(process.env.LUZ_LIVE_METRICS)await fs.writeFile(process.env.LUZ_LIVE_METRICS,JSON.stringify({at:new Date().toISOString(),metrics},null,2));
  } finally {
    if(session)await requestLive(session,'close',{out}).catch(()=>{});
    fixture.closeAllConnections();await new Promise(r=>fixture.close(r));
    for(const [key,old] of [['LUZ_CRAWL_STATE',previous.state],['LUZ_CRAWL_PROFILES',previous.profiles]])if(old===undefined)delete process.env[key];else process.env[key]=old;
    assert.equal(path.dirname(runtimeRoot),path.join(os.homedir(),'.luz-crawl','live'));
    await fs.rm(runtimeRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    await fs.rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
