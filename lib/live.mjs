import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { stateRoot, hash, findTaskArchive } from './archive.mjs';
import { validateURL } from './platforms.mjs';
import { OperationError } from './failure.mjs';

export function requireLiveExtension(status, profile) {
  const connected=status?.profiles?.find(item=>item.contextId===profile && item.extensionConnected);
  const version=connected?.extensionVersion?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/);
  if(!version || Number(version[1])<3 || Number(version[1])===3 && Number(version[2])<6)throw new OperationError('extension_update_required','live requires the connected LuzCrawl extension 3.6.0 or later. Reload its extension card, or use the dedicated default browser which loads this package automatically.');
}

export const liveOwner=()=>process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
export const liveRoot=()=>path.join(os.homedir(),'.luz-crawl','live',hash(path.resolve(stateRoot())).slice(0,16));
export function liveFile(id) {
  if(!/^[a-f0-9-]{36}$/.test(id||''))throw new OperationError('invalid_session','Invalid live session id.');
  return path.join(liveRoot(),id+'.json');
}
export async function privateWrite(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try { await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,file); }
  finally { await fs.rm(temp,{force:true}); }
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function taskFolder(out) {
  if(!out)throw new OperationError('task_required','Every live command requires --out pointing to the task returned by begin.');
  const task=await findTaskArchive(out);
  if(!task || path.resolve(task.folder)!==path.resolve(out))throw new OperationError('task_required','Use the existing task folder returned by begin.');
  return fs.realpath(task.folder);
}
const publicState=s=>({
  session:s.id,status:s.status,out:s.out,url:s.url,opened_at:s.opened_at,ttl_seconds:s.ttl,pid:s.pid,
  mode:s.profile?'connected':s.headed?'headed':'headless',
  ...(s.page_state?{page_state:s.page_state}:{}),...(s.error?{error:s.error}:{}),...(s.cleanup?{cleanup:s.cleanup}:{}),
});

export async function startLive(options) {
  const out=await taskFolder(options.out),url=validateURL(options.url).href;
  const ttl=Number(options.ttl ?? 900);
  if(!Number.isInteger(ttl)||ttl<60||ttl>3600)throw new OperationError('invalid_ttl','Idle TTL must be 60–3600 seconds.');
  if(options.profile && options.headed)throw new OperationError('invalid_session','Use --profile for a connected browser or --headed for a dedicated visible browser.');
  const id=randomUUID(),file=liveFile(id);
  const state={id,out,url,ttl,owner:liveOwner(),token:randomBytes(32).toString('hex'),status:'starting',opened_at:new Date().toISOString(),profile:options.profile,headed:options.headed===true};
  await privateWrite(file,state);
  const log=await fs.open(path.join(liveRoot(),id+'.log'),'a',0o600);
  let child,startError;
  try { child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/live-worker.mjs',import.meta.url)),file],{detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});child.on('error',error=>{startError=error;});child.unref(); }
  finally { await log.close(); }
  const started=Date.now();
  while(Date.now()-started<120000) {
    if(startError)throw startError;
    const current=JSON.parse(await fs.readFile(file,'utf8'));
    if(current.status==='ready')return {...publicState(current),open_elapsed_ms:Date.now()-started};
    if(['closed','failed'].includes(current.status))throw new OperationError('session_start_failed',current.error || 'Live session closed during startup.');
    await pause(150);
  }
  // The caller owns this worker; request cancellation without touching any other browser.
  await fs.writeFile(file+'.cancel','startup_timeout');
  throw new OperationError('session_start_timeout','Live startup exceeded 120 seconds; cancellation recorded.');
}

export async function requestLive(id,op,options={}) {
  const file=liveFile(id),out=await taskFolder(options.out);
  const state=JSON.parse(await fs.readFile(file,'utf8'));
  if(state.out!==out || state.owner!==liveOwner())throw new OperationError('session_owner_mismatch','Session belongs to another task or calling thread.');
  if(state.status!=='ready') { if(op==='status'||op==='close')return publicState(state);throw new OperationError('session_unavailable','Session is not running; open a new session after inspecting its records.'); }
  const requestId=options.requestId || randomUUID();
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId))throw new OperationError('invalid_request','Request ID must be 1–80 letters, digits, underscores or hyphens.');
  const address=new URL(state.endpoint);
  if(address.hostname!=='127.0.0.1'||address.protocol!=='http:'||address.pathname!=='/command'||address.username||address.password)throw new OperationError('invalid_endpoint','Invalid local live endpoint.');
  const {out:ignored,requestId:ignoredID,...settings}=options;
  let response;
  try { response=await fetch(state.endpoint,{method:'POST',headers:{authorization:`Bearer ${state.token}`,'content-type':'application/json'},body:JSON.stringify({id:requestId,op,session:id,out,options:settings}),signal:AbortSignal.timeout(900000)}); }
  catch { return {status:'outcome_unknown',request_id:requestId,code:'live_connection_lost',next_action:'Do not send a new write ID. Retry the same request ID and payload, then inspect/verify; a dead worker cannot restore unsaved page state.'}; }
  const result=await response.json();
  if(op==='close' && result.status==='closing') {
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) { const current=JSON.parse(await fs.readFile(file,'utf8')); if(current.status!=='ready')return {...result,...publicState(current)};await pause(150); }
  }
  return result;
}
