import { validateURL, sourceURL, platformOf } from './platforms.mjs';
import { createExecutionPolicy } from './execution.mjs';
import { OperationError } from './failure.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPage, scrollPage } from './extract-page.mjs';

// Serialized into the page; check every selector and form field before writing.
export function domOperation(step) {
  let root = document, doc = document, win = window, mutated = false;
  const visible = node => Boolean(node?.getClientRects().length && (node.ownerDocument?.defaultView || window).getComputedStyle?.(node)?.visibility !== 'hidden' && (typeof getComputedStyle !== 'function' || (node.ownerDocument?.defaultView?.getComputedStyle || getComputedStyle)(node).display !== 'none'));
  const label = node => node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => (node.getRootNode?.() || doc).getElementById?.(id)?.textContent || '').join(' ').trim() || [...(node.labels || [])].map(item => item.innerText).join(' ') || node.innerText || node.placeholder || node.title || '';
  const role = node => node.getAttribute('role') || ({ BUTTON: 'button', A: 'link', TEXTAREA: 'textbox', SELECT: 'combobox', FORM: 'form', ARTICLE: 'article', DIALOG: 'dialog' }[node.tagName]) || (/^H[1-6]$/.test(node.tagName) ? 'heading' : node.tagName === 'INPUT' ? /checkbox|radio/.test(node.type) ? node.type : /button|submit/.test(node.type) ? 'button' : 'textbox' : '');
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const selectorFor = node => {
    const candidates = [node.id && '#' + CSS.escape(node.id), ...['data-testid', 'name', 'aria-label'].map(key => node.getAttribute(key) && `${node.tagName.toLowerCase()}[${key}=${JSON.stringify(node.getAttribute(key))}]`)];
    const parts = [];
    for (let item = node; item && parts.length < 5; item = item.parentElement) {
      parts.unshift(item.id ? '#' + CSS.escape(item.id) : `${item.tagName.toLowerCase()}:nth-of-type(${[...(item.parentElement?.children || [item])].filter(peer => peer.tagName === item.tagName).indexOf(item) + 1})`);
      if (item.id) break;
    }
    candidates.push(parts.join(' > '));
    return candidates.find(candidate => candidate && (node.getRootNode?.() || root).querySelectorAll(candidate).length === 1) || null;
  };
  const describe = node => {
    const rect = node.getBoundingClientRect();
    return { tag: node.tagName, role: role(node), label: label(node).trim().slice(0, 300), type: node.type || undefined, selector: selectorFor(node), ...(step.scope?.length ? {scope:step.scope} : {}), disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'), requires_user: node.type === 'password' || node.autocomplete === 'one-time-code', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, document_x: rect.x + win.scrollX, document_y: rect.y + win.scrollY }, in_view: rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth };
  };
  const resolve = (target, unique = true) => {
    let nodes;
    try {
      nodes = target.selector ? [...root.querySelectorAll(target.selector)] : [...root.querySelectorAll('button,a[href],input,textarea,select,form,h1,h2,h3,h4,h5,h6,article,dialog,[role]')].filter(node => (!target.target?.role || role(node) === target.target.role) && (!target.target?.name || (target.target.exact === false ? label(node).includes(target.target.name) : label(node).trim() === target.target.name)));
    } catch { fail('invalid_selector', 'Invalid CSS selector.'); }
    nodes = nodes.filter(visible);
    if (unique && nodes.length !== 1) fail(nodes.length ? 'selector_ambiguous' : 'target_not_found', 'Action selector must match exactly one visible element.');
    return unique ? nodes[0] : nodes;
  };
  const writable = node => {
    if (node.type === 'password' || node.autocomplete === 'one-time-code' || node.closest('form')?.querySelector('input[type="password"],input[autocomplete="one-time-code"]')) fail('login_required', 'Password and verification forms require manual login.');
    if (!node.isConnected || node.disabled || node.matches?.(':disabled') || node.readOnly || node.closest('[inert]') || root.host?.closest('[inert]') || node.getAttribute('aria-disabled') === 'true') fail('target_disabled', 'Action target is detached, inert, disabled or read-only.');
    return node;
  };
  const fieldPlan = (field, root) => {
    const node = writable(resolve(field));
    if (root && !root.contains(node)) fail('invalid_form', 'A field is outside the declared form container.');
    if (field.checked !== undefined && !['checkbox', 'radio'].includes(node.type)) fail('invalid_form', 'Checked requires a checkbox or radio input.');
    if (field.value !== undefined && !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) && !node.isContentEditable) fail('invalid_form', 'The field does not support text or selection.');
    if (node.tagName === 'SELECT' && ![...node.options].some(option => option.value === field.value && !option.disabled)) fail('invalid_form', 'The requested select option is unavailable.');
    return { node, field };
  };
  const fill = ({ node, field }) => {
    writable(node);
    const owner = node.ownerDocument.defaultView;
    mutated = true;
    if (field.checked !== undefined) Object.getOwnPropertyDescriptor(owner.HTMLInputElement.prototype, 'checked').set.call(node, field.checked);
    else if (node.isContentEditable) node.textContent = field.value;
    else Object.getOwnPropertyDescriptor(({ INPUT: owner.HTMLInputElement, TEXTAREA: owner.HTMLTextAreaElement, SELECT: owner.HTMLSelectElement })[node.tagName].prototype, 'value').set.call(node, field.value);
    node.dispatchEvent(new owner.Event('input', { bubbles: true, composed:true })); node.dispatchEvent(new owner.Event('change', { bubbles: true, composed:true }));
    return { target: describe(node), filled: true };
  };
  const body = (document.body?.innerText || '').slice(0, 2000);
  const puzzlePrompt = [...document.querySelectorAll('div, span, p')].some(node => visible(node) && !node.closest('article') && /^(?:拖动下方拼图完成验证|请拖动滑块完成验证|请完成下方验证|为保证您的正常访问[,，]请进行如下验证)[。！!]*$/.test((node.innerText || '').replace(/\s+/g, '')));
  const verificationNotice = body.length < 1500
    && (/正在进行安全验证|验证您不是自动程序/i.test(body) || /^Security Verification$/i.test(document.title.trim()))
    && !document.querySelector('article');
  let gate = null;
  if (/^(?:429|too many requests|访问过于频繁|操作过于频繁)/i.test(document.title) || (body.length < 1500 && /^(?:too many requests|访问过于频繁|操作过于频繁)/i.test(body.trim()))) gate = 'rate_limited';
  else if (/^(?:访问验证|安全验证|安全检查|验证中心|Just a moment|Human verification|Verify you are human)/i.test(document.title)
    || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],#challenge-running,.geetest_panel')].some(visible)
    || puzzlePrompt || verificationNotice) gate = 'verification_required';
  else if (body.length < 2000 && /^405\s*[:：]\s*异常访问\s+[\s\S]*访问(?:已)?被阻止/.test(body.trim()) && !document.querySelector('article')) gate = 'access_denied';
  else if (/^(?:登录|登入|Sign in|Log in)(?:\s|$|[-|])/i.test(document.title) && [...document.querySelectorAll('input[type="password"]')].some(visible)) gate = 'login_required';
  try {
    for (const entry of step.scope || []) {
      const host = resolve({selector:entry.frame || entry.shadow});
      if (entry.frame) {
        try { root = host.contentDocument; } catch { root = null; }
        if (!root) fail('scope_inaccessible', 'Frame is cross-origin or unavailable; use an explicit frame-capable browser adapter.');
        doc = root; win = doc.defaultView;
      } else { root = host.shadowRoot; if (!root) fail('scope_inaccessible', 'No accessible open shadow root on this host.'); }
    }
    if (gate && !['read', 'locate', 'wait_for'].includes(step.action)) fail(gate, 'The page is restricted.');
    let value;
    if (step.action === 'read') {
      const node = !step.selector && !step.target ? root.body || root : resolve(step);
      const controls = [...node.querySelectorAll('button,a[href],input,textarea,select,[role="button"]')].filter(visible);
      const offset=step.offset || 0, limit=step.limit || 40, textOffset=step.text_offset || 0;
      const text=typeof node.innerText === 'string' ? node.innerText : [...node.children].filter(visible).map(n=>n.innerText || '').join('\n');
      const links=[...node.querySelectorAll('a[href]')].filter(visible);
      const frames=[...node.querySelectorAll('iframe,frame')].filter(visible);
      const shadows=[...node.querySelectorAll('*')].filter(n=>n.shadowRoot && visible(n));
      const tables=step.tables ? [...(node.tagName==='TABLE'?[node]:[]),...node.querySelectorAll('table')].filter(visible) : [];
      const rowOffset=step.row_offset || 0,rowLimit=step.row_limit || 20;
      const page = (items, cap=limit) => ({offset,limit:cap,total:items.length,truncated:offset+cap<items.length,next_offset:offset+cap<items.length?offset+cap:null});
      value = { text:text.slice(textOffset,textOffset+(step.max_chars || 30000)), text_offset:textOffset,text_total:text.length,text_truncated:textOffset+(step.max_chars || 30000)<text.length,
        controls:controls.slice(offset,offset+limit).map(describe), controls_total:controls.length,
        links:links.slice(offset,offset+limit).map(n=>({text:label(n).trim().slice(0,300),url:n.href,selector:selectorFor(n)})),
        frames:frames.slice(offset,offset+limit).map(n=>({selector:selectorFor(n),url:n.src,same_origin:Boolean(n.contentDocument)})),frames_total:frames.length,
        shadow_hosts:shadows.slice(offset,offset+limit).map(describe),shadow_hosts_total:shadows.length,
        tables:tables.slice(offset,offset+Math.min(limit,10)).map(n=>({selector:selectorFor(n),rows_total:n.rows.length,row_offset:rowOffset,next_row_offset:rowOffset+rowLimit<n.rows.length?rowOffset+rowLimit:null,truncated:rowOffset+rowLimit<n.rows.length || [...n.rows].some(r=>r.cells.length>10 || [...r.cells].some(c=>c.innerText.length>200)),rows:[...n.rows].slice(rowOffset,rowOffset+rowLimit).map(r=>[...r.cells].slice(0,10).map(c=>c.innerText.slice(0,200)))})),
        pagination:{controls:page(controls),links:page(links),frames:page(frames),shadow_hosts:page(shadows),tables:page(tables,Math.min(limit,10))}, target:node.getBoundingClientRect ? describe(node):null };
    } else if (step.action === 'locate') {
      const nodes = resolve(step, false), offset=step.offset||0,limit=step.limit||20; value = { matches: nodes.length, targets: nodes.slice(offset, offset+limit).map(describe), offset, truncated:offset+limit<nodes.length, viewport: { width: win.innerWidth, height: win.innerHeight, scroll_x: win.scrollX, scroll_y: win.scrollY } };
    } else if (step.action === 'wait_for') {
      const nodes = step.url ? [] : resolve(step, false); const node = nodes.length === 1 ? nodes[0] : null;
      const condition = step.condition || (step.url ? 'url' : step.checked !== undefined ? 'checked' : step.value !== undefined ? 'value' : step.text !== undefined || step.text_equals !== undefined ? 'text' : 'visible');
      const text = node ? typeof node.innerText === 'string' ? node.innerText : node.textContent || '' : '';
      if (node?.type === 'password') fail('login_required', 'Password values require manual login.');
      value = { satisfied: condition === 'url' ? (/^[\/?#]/.test(step.url) ? location.href.startsWith(new URL(step.url, location.href).href) : location.href === step.url) && document.readyState !== 'loading' && Boolean(document.body) && Boolean((document.body.innerText || '').trim()) : condition === 'hidden' ? nodes.length === 0 : condition === 'text' ? Boolean(node && (step.text_equals !== undefined ? text.trim() === step.text_equals : text.includes(step.text))) : condition === 'value' ? Boolean(node && node.value === step.value) : condition === 'checked' ? Boolean(node && typeof node.checked==='boolean' && node.checked===step.checked) : Boolean(node), matches: nodes.length, text: text.slice(0, 1000), target: node ? describe(node) : null };
    } else if (step.action === 'click' || step.action === 'native_prepare') {
      if (step.action === 'native_prepare' && (step.scope||[]).some(s=>s.frame)) fail('scope_unsupported', 'Native input currently supports the main frame and its open shadow roots only.');
      const node = writable(resolve(step)); node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = node.getBoundingClientRect(), x=Math.max(0, Math.min(win.innerWidth - 1, rect.x + rect.width / 2)), y=Math.max(0, Math.min(win.innerHeight - 1, rect.y + rect.height / 2));
      let hit=doc.elementFromPoint(x,y);
      while(hit?.shadowRoot) { const inner=hit.shadowRoot.elementFromPoint(x,y); if(!inner || inner===hit)break; hit=inner; }
      if (!hit || hit !== node && !node.contains(hit)) fail('target_obscured', 'The target is covered; inspect the overlay before clicking.');
      if (step.action === 'native_prepare') {
        if (step.kind === 'type' && (!['INPUT','TEXTAREA'].includes(node.tagName) || node.tagName === 'INPUT' && !['text','search','email','url','tel'].includes(node.type)) && !node.isContentEditable) fail('invalid_target','Native type supports text inputs, textarea and contenteditable.');
        if (step.kind === 'click' && node.tagName === 'A' && node.target && node.target !== '_self') fail('popup_unsupported','Inspect the destination and navigate explicitly; native popup clicks are not followed.');
        if (step.kind !== 'click') { mutated=true; node.focus(); }
        return {ok:true,url:location.href,title:document.title,gate,target:describe(node),point:{x,y}};
      }
      if (typeof node.click !== 'function') fail('invalid_target', 'The target does not support DOM click.');
      if (node.tagName === 'A') node.target = '_self';
      const target = describe(node), opened = [], originalOpen = win.open;
      // shortcut: capture synchronous popups; asynchronous popup workflows still need manual inspection.
      win.open = url => { opened.push(new URL(String(url || ''), win.location.href).href); return null; };
      try { mutated=true; node.click(); } finally { win.open = originalOpen; }
      if (opened.length > 1) fail('invalid_target', 'The click requested multiple pages; inspect the workflow manually.');
      value = { target, ...(opened.length ? { navigation_url: opened[0] } : {}), result: { click_method: 'dom', event_dispatched: true, effect_verified: false } };
    } else if (step.action === 'type') {
      const plan = fieldPlan({ ...step, value: step.text }); value = { ...fill(plan), result: { event_dispatched: true, effect_verified: false } };
    } else if (step.action === 'check') {
      const plan=fieldPlan({ ...step, checked:step.checked });
      if(plan.node.type==='radio' && !step.checked) fail('invalid_form','Select a different radio option instead of clearing one.');
      const unchanged=plan.node.checked===step.checked;
      if(!unchanged) { mutated=true;plan.node.click();if(plan.node.checked!==step.checked)fail('condition_failed','The checkbox/radio did not retain the requested state.'); }
      value={target:describe(plan.node),checked:plan.node.checked,unchanged};
    } else if (step.action === 'select') {
      const node=writable(resolve(step));
      if(node.tagName!=='SELECT' || !node.multiple && step.values.length!==1) fail('invalid_form','Select requires a select element and compatible option count.');
      for(const selected of step.values) if(![...node.options].some(o=>o.value===selected && !o.disabled && !o.parentElement.disabled)) fail('invalid_form','Requested option is unavailable.');
      mutated=true; for(const option of node.options)option.selected=step.values.includes(option.value);
      node.dispatchEvent(new win.Event('input',{bubbles:true,composed:true})); node.dispatchEvent(new win.Event('change',{bubbles:true,composed:true}));
      value={target:describe(node),selected:[...node.selectedOptions].map(o=>o.value),effect_verified:false};
    } else if (step.action === 'form') {
      const root = writable(resolve(step)); const plans = step.fields.map(field => fieldPlan(field, root));
      if (new Set(plans.map(item => item.node)).size !== plans.length) fail('invalid_form', 'Form fields must identify distinct controls.');
      value = { target: describe(root), fields: plans.map(fill), submitted: false };
    } else if (step.action === 'submit') {
      const form = writable(resolve(step));
      if (form.tagName !== 'FORM' || form.querySelector('input[type="password"]')) fail('invalid_form', 'Submit requires a non-login form.');
      const submitter = step.submitter ? writable(resolve({ selector: step.submitter })) : undefined;
      if (submitter && (submitter.form !== form || !['submit', 'image'].includes(submitter.type))) fail('invalid_form', 'Submitter must belong to the declared form.');
      if (!form.checkValidity()) fail('invalid_form', 'Required form fields are not valid.');
      mutated=true; form.requestSubmit(submitter); value = { target: describe(form), submitted: true, effect_verified: false };
    } else if (step.action === 'scroll') {
      const root = step.selector || step.target ? resolve(step) : doc.scrollingElement; const before = { x: root.scrollLeft, y: root.scrollTop };
      if (step.into_view) root.scrollIntoView({ block: step.block || 'center', inline: 'nearest', behavior: 'instant' });
      else { const amount = step.amount || 600; root.scrollBy(['left', 'right'].includes(step.direction) ? amount * (step.direction === 'left' ? -1 : 1) : 0, ['left', 'right'].includes(step.direction) ? 0 : amount * (step.direction === 'up' ? -1 : 1)); }
      value = { before, after: { x: root.scrollLeft, y: root.scrollTop }, target: describe(root), at_bottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 3 };
    } else fail('invalid_action','Unsupported DOM operation.');
    return { ok: true, url: location.href, title: document.title, gate, ...value };
  } catch (error) { return { ok: false, url: location.href, title: document.title, error: { code: error.code || 'invalid_target', message: error.message, outcome_unknown:mutated } }; }
}

export class BrowserOperations {
  constructor(page, policy, url, { progress } = {}) { this.page = page; this.policy = policy; this.url = url ? validateURL(url).href : undefined; this.browserCalls = 0; this.progress = progress; }
  summary() { return { ...this.policy.summary(), browser_calls: this.browserCalls }; }
  async reportProgress(patch = {}) { return this.progress?.(patch); }
  async navigate(value) {
    const url = validateURL(value).href; this.url = url;
    return this.policy.run('navigation', url, () => { this.browserCalls++; return this.page.goto(url); });
  }
  async evaluate(fn, value, { idempotent = true, label = 'page_read' } = {}) {
    const expression = (idempotent ? '' : '/*luzcrawl:once*/') + (typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(value)})`);
    return this.policy.run(idempotent ? 'read' : 'interaction', this.url, () => { this.browserCalls++; return this.page.evaluate(expression); }, { idempotent, label });
  }
  async dom(step) {
    if(step.method==='native' || step.action==='press') return this.nativeInput(step);
    const response = await this.evaluate(domOperation, step, { idempotent: ['read', 'locate', 'wait_for'].includes(step.action), label: step.action });
    if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean' || typeof response.url !== 'string') throw new OperationError('invalid_response', 'Invalid browser operation envelope.', {outcome_unknown:!['read','locate','wait_for'].includes(step.action)});
    if (response?.url) this.url = validateURL(response.url).href;
    if (response?.ok === false) throw new OperationError(response.error.code, response.error.message, {outcome_unknown:Boolean(response.error.outcome_unknown)});
    if (response.navigation_url) {
      try { await this.navigate(response.navigation_url); response.url = this.url; }
      catch(error) { throw new OperationError('write_outcome_unknown',`Click was dispatched but its requested navigation was not confirmed: ${error.message}`,{outcome_unknown:true,cause:error}); }
    }
    if (response?.gate === 'rate_limited') await this.policy.noteFailure(this.url, new OperationError('rate_limited', 'Page rate limit observed.'));
    const { ok, ...value } = response || {}; return { ...value, ...(value.url ? { url: sourceURL(value.url) } : {}) };
  }
  async waitFor(condition) { return this.policy.waitUntil(this.url, () => this.dom({ ...condition, action: 'wait_for' }), value => value.satisfied, condition); }
  async nativeInput(step) {
    if(typeof this.page.cdp!=='function') throw new OperationError('native_unavailable','This browser adapter has no native CDP input support.');
    let sent=false;
    const send=async (method,params) => { sent=true; this.browserCalls++; return this.page.cdp(method,params); };
    const key=async name=>{
      const base=name.replace(/^(Shift|Control)\+/,''), modifiers=name.startsWith('Control+')?2:name.startsWith('Shift+')?8:0;
      const code={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,A:65,Space:32}[base];
      const params={key:base==='Space'?' ':base,windowsVirtualKeyCode:code,modifiers};
      await send('Input.dispatchKeyEvent',{type:'keyDown',...params,...(!modifiers && ['Enter','Space'].includes(base)?{text:base==='Enter'?'\r':' '}: {})});
      await send('Input.dispatchKeyEvent',{type:'keyUp',...params});
    };
    try {
      const prepare={...step,action:'native_prepare',kind:step.action,method:undefined};
      let first=await this.dom(prepare), current=await this.dom(prepare);
      if(JSON.stringify(first.point)!==JSON.stringify(current.point) || first.target.selector!==current.target.selector || first.url!==current.url) throw new OperationError('target_unstable','Target moved between two observations; inspect and retry before sending input.');
      // Pace the whole gesture once; inserting a pacing delay while a key/button is held changes its meaning.
      await this.policy.run('interaction',this.url,async()=>{
        if(step.action==='click') {
          await send('Input.dispatchMouseEvent',{type:'mousePressed',...current.point,button:'left',clickCount:1});
          await send('Input.dispatchMouseEvent',{type:'mouseReleased',...current.point,button:'left',clickCount:1});
        } else if(step.action==='type') { await key('Control+A'); await send('Input.insertText',{text:step.text}); }
        else await key(step.key);
      },{idempotent:false,label:`native_${step.action}`});
      return {url:sourceURL(this.url),target:current.target,result:{input_method:'native',event_dispatched:true,effect_verified:false}};
    } catch(error) { if(sent) throw new OperationError('write_outcome_unknown','Native input may have taken effect; verify the page before another write.',{outcome_unknown:true,cause:error}); throw error; }
  }
  async wait(ms) { return this.policy.run('wait', this.url, () => this.policy.delay(ms), { attempts: 1, label: 'explicit_wait' }); }
  async extract(options = {}) {
    const args = { platform: platformOf(this.url), requestedURL: this.url, comments: false, includePresentation: false, ...options };
    const code = `(() => { const snapshot = (${extractPage.toString()})(${JSON.stringify(args)}); snapshot.scroll = (${scrollPage.toString()})(${JSON.stringify({move:false,comments:Boolean(args.comments),platform:args.platform})}); return snapshot; })()`;
    return this.evaluate(code, undefined, { label: 'extract_and_position' });
  }
  async screenshot(file, fullPage = false, attempts) {
    const data = await this.policy.run('read', this.url, () => { this.browserCalls++; return this.page.screenshot({ path: file, fullPage }); }, { attempts, label: fullPage ? 'full_page_screenshot' : 'viewport_screenshot' });
    // The extension returns base64 bytes; unlike a file-writing browser API,
    // it does not save the requested path on the local filesystem.
    const bytes = typeof data === 'string' ? Buffer.from(data.replace(/^data:image\/\w+;base64,/, ''), 'base64') : Buffer.isBuffer(data) ? data : null;
    if (bytes?.length) { await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, bytes); }
    return data;
  }
  async startResponseCapture(filter) { return this.policy.run('read', this.url, () => { this.browserCalls++; return this.page.startNetworkCapture(filter); }, { attempts: 1, label: 'observe_responses' }); }
  async readResponses() { return this.policy.run('read', this.url, () => { this.browserCalls++; return this.page.readNetworkCapture(); }, { label: 'read_observed_responses' }); }
}

export async function createBrowserOperations(page, options = {}) {
  return options.operations || new BrowserOperations(page, await createExecutionPolicy(options), options.url, { progress: options.progress });
}
