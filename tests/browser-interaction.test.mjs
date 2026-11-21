import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTestBrowser, edgeAvailable } from './edge-page.mjs';
import { domOperation, BrowserOperations } from '../lib/browser-operations.mjs';
import { executeActions, validateActions } from '../lib/browser-actions.mjs';
import { extractPage } from '../lib/extract-page.mjs';
import { testPolicy } from './helpers.mjs';

test('scoped DOM actions, pagination, selections and partial form side effects', { skip:!edgeAvailable }, async () => {
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Fixture</h1><form id="f"><input id="q"><select id="s" multiple><option value="a">A</option><option value="b">B</option></select><input id="c" type="checkbox"></form><div id="host"></div><iframe id="frame" srcdoc="<input id='inside'><p>Frame text</p>"></iframe><table><tr><th>Name</th></tr><tr><td>Alpha</td></tr></table><a href="/one">One</a><a href="/two">Two</a><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow</button>'; </script>`);
    const read = step => page.evaluate(domOperation, step);
    assert.equal((await read({action:'select',selector:'#s',values:['a','b']})).ok,true);
    assert.deepEqual(await page.evaluate('[...document.querySelector("#s").selectedOptions].map(o=>o.value)'),['a','b']);
    assert.equal((await read({action:'check',selector:'#c',checked:true})).ok,true);
    assert.equal(await page.evaluate('document.querySelector("#c").checked'),true);
    const shadow=await read({action:'locate',selector:'#shadow',scope:[{shadow:'#host'}]});
    assert.equal(shadow.matches,1); assert.equal(shadow.targets[0].selector,'#shadow');
    await page.evaluate('new Promise(resolve=>{const f=document.querySelector("#frame"); if(f.contentDocument?.querySelector("#inside"))resolve();else f.onload=resolve})');
    assert.equal((await read({action:'type',selector:'#inside',text:'kept',scope:[{frame:'#frame'}]})).ok,true);
    assert.equal(await page.evaluate('document.querySelector("#frame").contentDocument.querySelector("#inside").value'),'kept');
    const snapshot=await read({action:'read',limit:1,offset:1,tables:true,max_chars:5});
    assert.equal(snapshot.controls.length,1); assert.ok(snapshot.pagination.controls.truncated);
    assert.equal(snapshot.links.length,1); assert.ok(snapshot.text_truncated);
    assert.equal(snapshot.frames_total,1); assert.equal(snapshot.shadow_hosts_total,1);
    const table=await read({action:'read',tables:true}); assert.equal(table.tables[0].rows[1][0],'Alpha');
    await page.evaluate(`document.querySelector('table').innerHTML=Array.from({length:25},(_,i)=>'<tr><td>row '+i+'</td></tr>').join('')`);
    const laterRows=await read({action:'read',tables:true,row_offset:20,row_limit:5});
    assert.equal(laterRows.tables[0].rows[0][0],'row 20'); assert.equal(laterRows.tables[0].rows.length,5);
    assert.equal((await read({action:'wait_for',selector:'#c',checked:true})).satisfied,true);
    await page.evaluate(`document.querySelector('#q').addEventListener('input',()=>document.querySelector('#c').remove(),{once:true})`);
    const partial=await read({action:'form',selector:'#f',fields:[{selector:'#q',value:'changed'},{selector:'#c',checked:false}]});
    assert.equal(partial.ok,false); assert.equal(partial.error.outcome_unknown,true);
  } finally { await browser.close(); }
});

test('a rendered 405 denial stops capture and browser actions', { skip: !edgeAvailable }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-access-denied-'));
  const browser = await openTestBrowser();
  try {
    const page = await browser.newPage();
    const url = 'https://example.test/blocked';
    const notice = '检测到您的请求有异常行为，您的访问被阻止了。';
    await page.route(url, route => route.fulfill({ body: '<p>Test page</p>' }));
    await page.goto(url);
    await page.setContent('<title>出错了</title><main><h1>405：异常访问</h1><p>' + notice + '</p><button>获取帮助</button></main>');

    const snapshot = await page.evaluate(extractPage, { platform: 'web', requestedURL: url, includePresentation: false });
    assert.equal(snapshot.gate, 'access_denied');
    assert.equal(snapshot.target_present, false);

    const operations = new BrowserOperations(page, testPolicy(directory), url);
    const result = await executeActions(page, {
      url, current_page: true, operations, allowWrite: true,
      steps: [{ action: 'read' }, { action: 'click', selector: 'button' }],
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.stop_reason, 'access_denied');
    assert.equal(result.attempted, 1);
    assert.match(result.results[0].value.text, /405：异常访问/);
    const click = await page.evaluate(domOperation, { action: 'click', selector: 'button' });
    assert.equal(click.error.code, 'access_denied');

    await page.setContent('<title>错误码说明</title><article><h1>405：异常访问</h1><p>常见错误示例：' + notice + '</p></article>');
    assert.equal((await page.evaluate(extractPage, { platform: 'web', requestedURL: url, includePresentation: false })).gate, null);
    assert.equal((await page.evaluate(domOperation, { action: 'read' })).gate, null);

    await page.setContent('<title>Security Verification</title><main><h1>Security Verification</h1></main>');
    assert.equal((await page.evaluate(extractPage, { platform: 'web', requestedURL: url, includePresentation: false })).gate, 'verification_required');
    assert.equal((await page.evaluate(domOperation, { action: 'read' })).gate, 'verification_required');
  } finally {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native click, replace text and Enter dispatch trusted input once', { skip:!edgeAvailable }, async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'luz-native-'));
  const browser=await openTestBrowser();
  try {
    const page=await browser.newPage();
    await page.setContent(`<form id="f"><input id="q" value="old"><button id="b">Send</button></form><output id="n">0</output><script>window.clicks=0;window.trusted=false;document.querySelector('#b').onclick=e=>{window.trusted=e.isTrusted};document.querySelector('#f').onsubmit=e=>{e.preventDefault();document.querySelector('#n').textContent=++window.clicks};</script>`);
    const operations=new BrowserOperations(page,testPolicy(directory),'https://example.com');
    // setContent keeps about:blank; route a real URL so envelopes meet URL validation.
    await page.route('https://example.com/**',r=>r.fulfill({body:'<p>placeholder</p>'}));
    const html=await page.evaluate('document.documentElement.outerHTML'); await page.goto('https://example.com/fixture'); await page.setContent(html);
    await operations.dom({action:'type',selector:'#q',text:'中文 new',method:'native'});
    assert.equal(await page.evaluate('document.querySelector("#q").value'),'中文 new');
    await operations.dom({action:'click',selector:'#b',method:'native'});
    assert.equal(await page.evaluate('window.clicks'),1); assert.equal(await page.evaluate('window.trusted'),true);
    await operations.dom({action:'press',selector:'#q',key:'Enter'});
    assert.equal(await page.evaluate('window.clicks'),2);
    assert.throws(()=>validateActions([{action:'press',selector:'#q',key:'Enter'}]),{code:'authorization_required'});
  } finally { await browser.close(); await fs.rm(directory,{recursive:true,force:true}); }
});
