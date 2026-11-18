#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { withHeadlessSession } from '../lib/headless.mjs';
import { withBrowser } from '../lib/browser-session.mjs';
import { createLiveController } from '../lib/live-controller.mjs';
import { createLiveServer } from '../lib/live-server.mjs';
import { privateWrite, requireLiveExtension } from '../lib/live.mjs';
import { atomicWrite } from '../lib/archive.mjs';
import { fetchDaemonStatus } from '../lib/bridge/client.mjs';

const file=process.argv[2];
const state=JSON.parse(await fs.readFile(file,'utf8'));
let stop, interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;stop?.();});
const audit=path.join(state.out,'raw/live',state.id);
let server;
try {
  const run=async profile=>{
    requireLiveExtension(await fetchDaemonStatus({contextId:profile}),profile);
    return withBrowser('live',{out:state.out,url:state.url,profile,window:state.headed?'foreground':'background',idleTimeout:state.ttl+60,access_mode:state.profile?'authorized_browser':'public'},async(page,options,_kind,operations)=>{
    await operations.navigate(state.url);
    if(interrupted || await fs.access(file+'.cancel').then(()=>true,()=>false))throw new Error('Live startup cancelled.');
    const controller=createLiveController(page,{...options,id:state.id});
    const done=new Promise(resolve=>{stop=resolve;});
    server=await createLiveServer({directory:path.join(audit,'requests'),token:state.token,session:state.id,out:state.out,ttl:state.ttl,...controller,onExpire:()=>stop('idle_expired'),onClose:()=>stop('explicit_close')});
    await atomicWrite(path.join(audit,'session.json'),{id:state.id,out:state.out,url:state.url,opened_at:state.opened_at,status:'ready',page:page.getActivePage(),context_id:page.contextId});
    await privateWrite(file,{...state,status:'ready',pid:process.pid,endpoint:server.url});
    const reason=await done;
    await server.close();server=null;
    return {status:'completed',stop_reason:reason || 'interrupted',live:controller.status()};
    });
  };
  const result=state.profile ? await run(state.profile):await withHeadlessSession(run,{headed:state.headed});
  const {token,endpoint,...safe}=state;
  const closed=result.browser?.closed===true;
  await privateWrite(file,{...safe,pid:process.pid,status:closed?'closed':'failed',error:result.error || result.cleanup_error,cleanup:{owned_page_closed:closed,stop_reason:result.stop_reason}});
  await atomicWrite(path.join(audit,'closed.json'),result);
} catch(error) {
  await server?.close().catch(()=>{});
  const {token,endpoint,...safe}=state;
  await privateWrite(file,{...safe,status:'failed',pid:process.pid,error:error.message});
  process.exitCode=1;
} finally { await fs.rm(file+'.cancel',{force:true}); }
