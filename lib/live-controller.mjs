import { createBrowserOperations } from './browser-operations.mjs';
import { executeActions, validateActions, WRITE_ACTIONS } from './browser-actions.mjs';
import { validateURL } from './platforms.mjs';
import { OperationError } from './failure.mjs';
import { capture } from './capture.mjs';

const safeActions = new Set(['read','locate','wait_for','extract','screenshot']);

export function createLiveController(page, options) {
  let currentURL=options.url, pending=null;
  const status=()=>({status:pending?'verification_required':'ready',url:currentURL,pending_verification:pending,session:options.id,page:page.getActivePage?.()});
  const dispatch=async message=>{
    if(message.op==='close')return {status:'closing',pending_verification:pending};
    if(!['inspect','act','navigate','capture','verify'].includes(message.op))throw new OperationError('invalid_operation','Unknown live operation.');
    const settings=message.options || {};
    let steps;
    if(message.op==='inspect' || message.op==='act') {
      steps=validateActions(settings.steps || (message.op==='inspect'?[{action:'read'}]:null), settings.allowWrite===true);
      if(message.op==='inspect' && steps.some(s=>!safeActions.has(s.action)))throw new OperationError('invalid_action','inspect accepts read, locate, wait_for, extract and screenshot only.');
    }
    if(pending && (['navigate','capture'].includes(message.op) || steps?.some(s=>!safeActions.has(s.action))))throw new OperationError('write_outcome_unknown','Verify the pending effect before another write or navigation.',{outcome_unknown:true});
    const operations=await createBrowserOperations(page,{out:options.out,profile:options.profile,url:currentURL});
    const observed=await operations.evaluate(()=>({url:location.href,title:document.title}),undefined,{label:'live_location'});
    currentURL=validateURL(observed.url).href; operations.url=currentURL;
    if(message.op==='verify') {
      if(!pending)throw new OperationError('nothing_pending','There is no uncertain write to verify.');
      if(settings.pending_id!==pending.request_id || typeof settings.note!=='string' || !settings.note.trim() || settings.note.length>2000)throw new OperationError('invalid_verification','Provide pending_id and a short explanation of how the condition establishes the business effect.');
      const expect=settings.expect || pending.expect;
      validateActions([{...expect,action:'wait_for'}]);
      if(pending.expect && JSON.stringify(expect)!==JSON.stringify(pending.expect))throw new OperationError('invalid_verification','Use the original expected effect for this pending write.');
      const evidence=await operations.waitFor(expect);
      if(!evidence.satisfied)return {status:'verification_required',pending_verification:pending,evidence};
      const resolved=pending;pending=null;
      return {status:'verified',resolved_request_id:resolved.request_id,evidence,note:settings.note};
    }
    if(message.op==='navigate') {
      await operations.navigate(validateURL(settings.url).href);currentURL=operations.url;
      return {status:'completed',...await operations.dom({action:'read',max_chars:10000,limit:20})};
    }
    if(message.op==='capture') {
      if(!Number.isInteger(settings.scrolls ?? 1) || (settings.scrolls ?? 1)<0 || (settings.scrolls ?? 1)>100)throw new OperationError('invalid_action','scrolls must be from 0 to 100.');
      return capture(page,{url:currentURL,out:options.out,current_page:true,related:true,scrolls:settings.scrolls ?? 1,screenshot:settings.screenshot!==false,comments:settings.comments===true,access_mode:options.access_mode},operations);
    }
    const result=await executeActions(page,{url:currentURL,out:options.out,steps,allowWrite:settings.allowWrite===true,current_page:true,operations});
    currentURL=operations.url;
    if(result.pending_verification)pending={...result.pending_verification,request_id:message.id};
    // Partial DOM mutations carry outcome_unknown even when validation failed later in a form.
    if(!pending && result.error?.outcome_unknown && steps.some(s=>WRITE_ACTIONS.includes(s.action)))pending={request_id:message.id};
    return {...result,live:status()};
  };
  return {dispatch,status};
}
