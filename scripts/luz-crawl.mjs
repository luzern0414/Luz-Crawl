#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { doctor } from '../lib/doctor.mjs';
import { atomicWrite, createTaskArchive, DEFAULT_OUTPUT, findExperience, findTaskArchive, loadExperience, lzCompactEvents, verifyArchive } from '../lib/archive.mjs';
import { lzFixURL, validateURL } from '../lib/platforms.mjs';
import { preferences, rememberPreferences, rememberSite, sites, pendingTasks, loadTask } from '../lib/memory.mjs';
import { readActions, ACTION_SCHEMA } from '../lib/browser-actions.mjs';
import { syncBrowserPreferences } from '../lib/browser-preferences.mjs';
import { collect, refreshCollection } from '../lib/collect.mjs';
import { accessPolicy } from '../lib/execution.mjs';
import { classifyFailure } from '../lib/failure.mjs';
import { VERSION, API_VERSION } from '../lib/version.mjs';
import { pickVisibleProfile, withHeadlessSession } from '../lib/headless.mjs';
import { batchConcurrency, DEFAULT_CONCURRENCY, readBatch } from '../lib/batch.mjs';
import { writeCrawlSummary } from '../lib/crawl-summary.mjs';
import { lzNote, lzNotes, lzNotesCheck, lzNotesList, lzNotesPrune } from '../lib/notes.mjs';
import { lzScope } from '../lib/scope.mjs';
import { lzLibrary } from '../lib/site-library.mjs';
import { checkRobots } from '../lib/robots.mjs';
import { startLive, requestLive } from '../lib/live.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const print = (value) => console.log(JSON.stringify(value, null, 2));

// Each browser command runs in its own process (lib/host.mjs) so environment changes made by the silent/visible fallback
// stay confined to that command; stdout carries the JSON result, stderr the progress messages.
const HOST = path.join(root, 'lib', 'host.mjs');
async function hostCommand(args, diagnosticsFile) {
  const log = diagnosticsFile ? await fs.open(diagnosticsFile, 'wx') : null;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOST, ...args], { shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', log?.fd ?? 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => process.stderr.write(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`LuzCrawl runtime exited ${code}. ${diagnosticsFile || output.trim()}`));
      });
    });
  } finally {
    await log?.close();
  }
}

async function lookupExperience(query, platform, category, snapshot) {
  const [notes, history] = await Promise.all([
    lzNotes(query, platform, { category }),
    findExperience(query, platform, { category, snapshot }),
  ]);
  const categories = Object.fromEntries([...new Set(notes.map(note => note.category))].map(name => [name, notes.filter(note => note.category === name).length]));
  return { notes, categories, ...history };
}

function captureArgs(url, options) {
  const args = ['luz-crawl', 'capture', url, '--out', path.resolve(options.out), '--scrolls', String(options.scrolls ?? 20), '-f', 'json'];
  if (options.comments) args.push('--comments');
  if (options.download) args.push('--download');
  if (options.resume) args.push('--resume');
  if (options.screenshot === false) args.push('--no-screenshot');
  if (options.profile) args.unshift('--profile', options.profile);
  if (options.window) args.push('--window', options.window);
  return args;
}

const usage = `LuzCrawl ${VERSION} — skill, browser extension and local memory
  node scripts/luz-crawl.mjs doctor
  node scripts/luz-crawl.mjs begin "task or request name" --out OUTPUT_ROOT [--new]
  node scripts/luz-crawl.mjs headless-login [TASK_ID or URL]
  node scripts/luz-crawl.mjs install
  node scripts/luz-crawl.mjs collect "topic or URL" [--platform xhs,github,bing] [--file plan.json] [--read 1] --out TASK_FOLDER [--compact] [--concurrency 2]
  node scripts/luz-crawl.mjs report COLLECTION_DIRECTORY
  node scripts/luz-crawl.mjs summary TASK_DIRECTORY [--keep-raw]
  node scripts/luz-crawl.mjs robots URL
  node scripts/luz-crawl.mjs capture URL --out TASK_FOLDER [--scrolls 20] [--comments] [--download] [--profile ID]
  node scripts/luz-crawl.mjs batch --file jobs.json --out TASK_FOLDER [--compact] [--concurrency 6] [--allow-write] [--resume]
  node scripts/luz-crawl.mjs search PLATFORM_OR_DOMAIN "query" --out TASK_FOLDER [--read 1] [--compact] [--concurrency 6] [--comments] [--download] [--no-screenshot]
  node scripts/luz-crawl.mjs search web "query" --site example.com --out TASK_FOLDER
  node scripts/luz-crawl.mjs experience --query "keyword" [--platform x] [--category keyword|route|source|failure|verification|method|general]
  node scripts/luz-crawl.mjs experience --file lookups.json
  node scripts/luz-crawl.mjs sites [--category analytics]
  node scripts/luz-crawl.mjs remember --out DIRECTORY --format html [--keywords "word1,word2"]
  node scripts/luz-crawl.mjs remember --browser edge --profile PROFILE_ID [--no-reuse-profile]
  node scripts/luz-crawl.mjs remember --site https://example.com --name example --template "https://example.com/search?q={query}"
  node scripts/luz-crawl.mjs note --kind preference|lesson|fact --key TOPIC --text "one line" [--category CATEGORY] [--tags "词,别名"] [--when "适用条件"] [--source URL] [--outcome success|failure|mixed|unverified] [--valid-until YYYY-MM-DD] [--why WHY] [--platform ID] [--codified] [--public --when "situation"]
  node scripts/luz-crawl.mjs list [--kind lesson]
  node scripts/luz-crawl.mjs prune
  node scripts/luz-crawl.mjs check
  node scripts/luz-crawl.mjs experience --compact
  node scripts/luz-crawl.mjs pending
  node scripts/luz-crawl.mjs continue TASK_ID
  node scripts/luz-crawl.mjs cancel TASK_ID
  node scripts/luz-crawl.mjs verify DIRECTORY
  node scripts/luz-crawl.mjs download ARCHIVE_DIRECTORY
  node scripts/luz-crawl.mjs browser URL --file actions.json [--allow-write]
  node scripts/luz-crawl.mjs browser URL --steps JSON [--allow-write]
  node scripts/luz-crawl.mjs live open URL --out TASK_FOLDER [--headed | --profile ID] [--ttl 900]
  node scripts/luz-crawl.mjs live inspect SESSION --out TASK_FOLDER [--file reads.json]
  node scripts/luz-crawl.mjs live act SESSION --out TASK_FOLDER --file actions.json --allow-write [--request-id ID]
  node scripts/luz-crawl.mjs live navigate SESSION URL --out TASK_FOLDER
  node scripts/luz-crawl.mjs live capture SESSION --out TASK_FOLDER [--scrolls 1]
  node scripts/luz-crawl.mjs live verify SESSION --out TASK_FOLDER --file verification.json
  node scripts/luz-crawl.mjs live status|close SESSION --out TASK_FOLDER
  node scripts/luz-crawl.mjs schema
  node scripts/luz-crawl.mjs policy [--file policy.json]
For a visible visit to the original URL, use live open URL --headed --out TASK_FOLDER followed by live inspect. One-shot reads start in an isolated silent Edge and may supplement incomplete content in a connected browser. Explicit access denial stops automatic retries. --profile ID selects a connected browser.
Output: --out wins, then the saved output preference, else ${DEFAULT_OUTPUT}; keep the output root outside this skill directory. The coordinator runs begin --out OUTPUT_ROOT --new once per request and passes the returned folder with --out to every operation and delegated agent; delegated agents never run begin. Task folders are bound to the session (CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID); without a session ID, begin without --new reuses the latest active task under the same output root. Layout: OUTPUT_ROOT/NNN-topic/ holds raw/ (everything crawled and every machine record, one folder per page under raw/NNNN_title/) and NNN-topic.html (the summary) beside it; the number is the highest one under OUTPUT_ROOT plus one, and an older NNN_topic folder counts and stays readable.
Browser Bridge must be connected. Follow SKILL.md (调用协议); installation is in references/install.md.`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, allowNegative: true, options: { codified: { type: 'boolean' }, 'keep-raw': { type: 'boolean' }, headed: { type: 'boolean' }, ttl: { type: 'string' }, 'request-id': { type: 'string' }, headless: { type: 'boolean' }, out: { type: 'string' }, new: { type: 'boolean' }, scrolls: { type: 'string' }, concurrency: { type: 'string' }, comments: { type: 'boolean' }, download: { type: 'boolean' }, screenshot: { type: 'boolean' }, 'allow-write': { type: 'boolean' }, resume: { type: 'boolean' }, file: { type: 'string' }, steps: { type: 'string' }, query: { type: 'string' }, platform: { type: 'string' }, read: { type: 'string' }, site: { type: 'string' }, profile: { type: 'string' }, browser: { type: 'string' }, 'reuse-profile': { type: 'boolean' }, window: { type: 'string' }, format: { type: 'string' }, name: { type: 'string' }, template: { type: 'string' }, keywords: { type: 'string' }, category: { type: 'string' }, tags: { type: 'string' }, source: { type: 'string' }, outcome: { type: 'string' }, 'valid-until': { type: 'string' }, compact: { type: 'boolean' }, note: { type: 'string' }, key: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, when: { type: 'string' }, public: { type: 'boolean' }, help: { type: 'boolean' } } });
  // A pasted page URL is repaired (full-width punctuation, missing or misspelt scheme) before any command validates it.
  if (['capture', 'browser', 'headless-login'].includes(positionals[0]) && positionals[1] && !/^[a-f0-9-]{36}$/.test(positionals[1])) positionals[1] = lzFixURL(positionals[1]);
  const [command, ...args] = positionals;
  if (values.help || !command) { console.log(usage); return; }
  if (values.concurrency !== undefined && ['search','collect'].includes(command)) batchConcurrency(values.concurrency);
  if (command === 'live') {
    const [op,id,url]=args;
    let result;
    if(op==='open') result=await startLive({out:values.out,url:lzFixURL(id),headed:values.headed,profile:values.profile,ttl:values.ttl});
    else {
      const options={out:values.out,requestId:values['request-id']};
      if(['act','inspect'].includes(op)) { options.steps=op==='inspect' && !values.file && !values.steps ? [{action:'read'}] : await readActions(values); options.allowWrite=values['allow-write']===true; }
      else if(op==='navigate')options.url=validateURL(lzFixURL(url)).href;
      else if(op==='capture')Object.assign(options,{scrolls:values.scrolls===undefined?1:Number(values.scrolls),screenshot:values.screenshot!==false,comments:values.comments===true});
      else if(op==='verify') { if(!values.file)throw new Error('live verify requires --file verification.json.');const verification=JSON.parse(await fs.readFile(path.resolve(values.file),'utf8'));Object.assign(options,{pending_id:verification.pending_id,note:verification.note,expect:verification.expect}); }
      else if(!['status','close'].includes(op))throw new Error('Unknown live operation; use open/status/inspect/act/navigate/capture/verify/close.');
      result=await requestLive(id,op,options);
    }
    print(result);
    if(!['ready','completed','captured','partial','verified','closed','closing'].includes(result.status))process.exitCode=2;
    return;
  }
  if (command === 'batch') values.batchJobs = await readBatch(values);
  if (command === 'search' && args.length !== 2) throw new Error('Search requires one platform and one query. Use batch --file for multiple queries.');
  if (command === 'browser') {
    validateURL(args[0]);
    if (values.file === '-') { if (values.steps !== undefined) throw new Error('Use only --steps or --file.'); let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 5 * 1024 * 1024) throw new Error('Action input exceeds 5 MiB.'); } values.steps = input; values.file = undefined; }
    values.steps = JSON.stringify(await readActions(values)); values.file = undefined;
  }
  if (command === 'headless-login') {
    const task = args[0] && /^[a-f0-9-]{36}$/.test(args[0]) ? await loadTask(args[0]) : null;
    const url = validateURL(task?.url || args[0] || 'https://x.com/i/flow/login').href;
    const result = await withHeadlessSession(async (_, edge) => {
      console.error(`请在独立 Edge 窗口完成 ${new URL(url).hostname} 的登录或验证，然后关闭该窗口。无需向 Agent 发送密码。`);
      const closed = await Promise.race([edge.exited.then(() => true), new Promise((resolve) => setTimeout(resolve, 600000, false))]);
      if (!closed) throw new Error('The login window was not closed within 10 minutes.');
      return { status: 'profile_saved', login_verified: false, url, next_action: task ? `Run continue ${task.id} to verify and resume the saved task silently.` : `Capture ${url} to verify the saved login silently.` };
    }, { headed: true, startUrl: url });
    print(result); return;
  }
  if (values.headless || !values.profile && ['capture','batch','search','browser','collect','download','continue'].includes(command)) {
    if (values.profile) throw new Error('--headless uses its own persistent profile; omit --profile.');
    let started = false;
    try {
      return await withHeadlessSession(profile => { started = true; return execute({ ...values, headless: false, profile, window: 'background' }, positionals); });
    } catch (error) {
      if (started || values.headless) throw error;
      console.error(`[LuzCrawl] 静默浏览器未能启动（${error.message}），改用可见浏览器继续。`);
      const visible = await pickVisibleProfile();
      // Never fall through to an unspecified profile: the bridge could route it to another session's silent browser.
      if (!visible) throw new Error(`静默浏览器未能启动（${error.message}），也没有已连接的可见浏览器。请打开已加载 LuzCrawl 扩展的 Edge 后重试。`);
      return execute({ ...values, headless: false, profile: visible, window: 'background' }, positionals);
    }
  }
  return execute(values, positionals);
}

async function execute(values, positionals) {
  const [command, ...args] = positionals;
  if (command === 'schema') { print({ version: VERSION, api_version: API_VERSION, actions: ACTION_SCHEMA }); return; }
  if (command === 'policy') { print(await accessPolicy(values.file ? JSON.parse(await fs.readFile(path.resolve(values.file), 'utf8')) : undefined)); return; }
  const defaults = await preferences();
  if (defaults.reuse_browser_profile !== false) values.profile ||= defaults.browser_profile;
  if (command === 'begin') {
    if (!args[0]) throw new Error('A task or request name is required.');
    const output = values.out || (await syncBrowserPreferences(values.profile)).output_dir;
    const folder = await createTaskArchive(output, args[0], { newTask: values.new });
    print({ folder, title: args[0], status: 'ready' }); return;
  }
  if (command === 'doctor') {
    const result = await doctor({ profile: values.profile });
    if (values.out) {
      const folder = (await findTaskArchive(values.out))?.folder || await createTaskArchive(values.out, 'doctor');
      await atomicWrite(path.join(folder, 'raw', 'doctor.json'), result);
    }
    // Exit 0 when the environment can start a read: a connected extension (ready) or the silent Edge (silent_ready).
    print(result); process.exitCode = result.ready || result.silent_ready ? 0 : 2; return;
  }
  if (command === 'install') {
    // Nothing to install: the runtime, bridge and extension all live in this folder. Check the environment, start the
    // bridge, and point at the one manual step (loading browser-extension/ in Edge).
    const result = await doctor({ profile: values.profile });
    const legacyPlugin = path.join(os.homedir(), '.opencli', 'plugins', 'luz-crawl');
    const legacy = await fs.lstat(legacyPlugin).then(() => legacyPlugin, () => null);
    print({ ...result, next_steps: result.ready ? [] : [result.extension_install.manual_step], ...(legacy ? { legacy_opencli_plugin: { path: legacyPlugin, note: 'Left over from the OpenCLI-based release; LuzCrawl no longer uses it and it can be removed.' } } : {}) });
    process.exitCode = result.ready ? 0 : 2; return;
  }
  if (command === 'experience') {
    if (values.compact) { print(await lzCompactEvents(true)); return; }
    if (!values.file) { print(await lookupExperience(values.query || '', values.platform, values.category)); return; }
    if (values.query || values.platform) throw new Error('Use --file or --query/--platform for experience.');
    const requests = JSON.parse((await fs.readFile(path.resolve(values.file), 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(requests) || !requests.length || requests.some(row => !row || typeof row.query !== 'string' || !row.query.trim()
      || row.platform !== undefined && typeof row.platform !== 'string')) throw new Error('Experience input is an array of {query, platform?} lookups.');
    const snapshot = await loadExperience();
    const lookups = [];
    for (const { query, platform } of requests) {
      lookups.push({ query, platform, ...await lookupExperience(query, platform, values.category, snapshot) });
    }
    print({ lookups });
    return;
  }
  // Advice before a bulk or repeated read: what the site's robots.txt says about this path (RFC 9309). Exit 2 = disallowed or unreachable.
  if (command === 'robots') { if (!args[0]) throw new Error('A URL is required.'); const result = await checkRobots(args[0]); print(result); process.exitCode = result.allowed ? 0 : 2; return; }
  if (command === 'sites') { print((await sites()).filter((item) => !values.category || item.category === values.category)); return; }
  if (command === 'pending') { print(await pendingTasks()); return; }
  if (command === 'note') { print(await lzNote(values)); return; }
  if (command === 'list') { print(await lzNotesList(values.kind, values.category)); return; }
  if (command === 'prune') { print(await lzNotesPrune()); return; }
  if (command === 'check') { const result = await lzNotesCheck(); print(result); if (!result.ok) process.exitCode = 2; return; }
  if (command === 'remember') {
    if (values.note) { print(await lzNote(values)); return; }
    const saved = values.site ? await rememberSite(values) : await rememberPreferences(values);
    print(values.out && !values.site ? await syncBrowserPreferences(values.profile) : saved); return;
  }
  if (command === 'continue' || command === 'cancel') {
    if (!args[0]) throw new Error('A pending task ID is required.');
    await loadTask(args[0]);
    const native = ['luz-crawl', command, args[0], '-f', 'json'];
    if (values.profile) native.unshift('--profile', values.profile);
    console.log(await hostCommand(native)); return;
  }
  if (command === 'verify') { if (!args[0]) throw new Error('Archive directory is required.'); const result = await verifyArchive(args[0]); print(result); process.exitCode = result.ok ? 0 : 2; return; }
  if (command === 'download') {
    if (!args[0]) throw new Error('Archive directory is required.');
    const native = ['luz-crawl','download',path.resolve(args[0]),'-f','json'];
    if (values.profile) native.unshift('--profile',values.profile);
    console.log(await hostCommand(native)); return;
  }
  if (command === 'report') { if (!args[0]) throw new Error('Collection directory is required.'); print(await refreshCollection(args[0])); return; }
  if (command === 'summary') {
    if (!args[0]) throw new Error('Task directory is required.');
    const summary = await writeCrawlSummary(args[0], { finalize: !values['keep-raw'] });
    print(summary);
    if (summary.cleanup?.errors.length) process.exitCode = 2;
    return;
  }
  if (!['capture', 'batch', 'search', 'browser', 'collect'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const current = await syncBrowserPreferences(values.profile);
  values.out ||= current.output_dir;
  values.window ||= 'background';
  let batchURLs;
  if (command === 'batch') {
    batchURLs = values.batchJobs.map(job => job.url).filter(Boolean);
  }
  if (command === 'capture' || command === 'browser') validateURL(args[0]);
  if (command === 'search' && (!args[0] || !args[1])) throw new Error('Search requires platform and query.');
  if (command === 'collect' && !args[0] && !values.file) throw new Error('Provide a topic, URL or --file.');
  const archiveTitle = command === 'search' ? `${args[0]}_${args[1]}` : command === 'batch' ? `batch_${path.basename(values.file)}` : command === 'collect' ? `collect_${args[0] || values.name || path.basename(values.file || 'links')}` : `${command}_${args[0] || 'run'}`;
  const archiveFolder = (await findTaskArchive(values.out))?.folder || await createTaskArchive(values.out, archiveTitle);
  const health = await doctor({ profile: values.profile });
  if (!health.ready && !(['profile_selection_required', 'profile_disconnected'].includes(health.state) && values.profile)) {
    await atomicWrite(path.join(archiveFolder, 'raw', 'preflight.json'), { command, status: 'blocked', browser_opened: false, requested: values.batchJobs?.length ?? (command === 'capture' ? 1 : undefined), sources: batchURLs, attempted: 0, health });
    print(health); process.exitCode = 2; return;
  }
  await atomicWrite(path.join(archiveFolder, 'raw', 'preflight.json'), { command, status: 'ready_to_attempt', requested: values.batchJobs?.length, health });
  if (command === 'collect') {
    const input=args[0] || values.name || path.basename(values.file);
    let result;
    if (values.compact) {
      const native=['luz-crawl','collect',input,'--out',archiveFolder,'--compact','-f','json'];
      if (values.profile) native.unshift('--profile',values.profile);
      for (const key of ['file','name','platform','window','read','scrolls','concurrency']) if (values[key] !== undefined) native.push(`--${key}`,values[key]);
      for (const key of ['comments','download','screenshot','resume']) if (typeof values[key] === 'boolean') native.push(`--${values[key] ? '' : 'no-'}${key}`);
      const diagnostics_file=path.join(archiveFolder,'raw',`collection-${randomUUID()}.log`);
      result=JSON.parse(await hostCommand(native,diagnostics_file));
      console.log(JSON.stringify({...result,diagnostics_file}));
    } else {
      result=await collect(input,{...values,out:archiveFolder});
      print(result);
    }
    if(!['captured','completed'].includes(result.status)) process.exitCode=2;
  } else if (command === 'capture') {
    const output = await hostCommand(captureArgs(args[0], { ...values, out: archiveFolder }));
    console.log(output);
    const result = JSON.parse(output);
    await lzLibrary([result]);
    await lzScope(archiveFolder, [result]);
    if (['blocked', 'failed'].includes(result.status)) process.exitCode = 2;
  } else if (command === 'browser') {
    const native = ['luz-crawl', 'browser', args[0], '--steps', values.steps, '--out', archiveFolder, '--window', values.window, '-f', 'json'];
    if (values.profile) native.unshift('--profile', values.profile);
    if (values['allow-write']) native.push('--allow-write');
    if (values.screenshot === false) native.push('--no-screenshot');
    const output = await hostCommand(native); console.log(output);
    if (JSON.parse(output).status !== 'completed') process.exitCode = 2;
  } else if (command === 'search') {
    const native = ['luz-crawl', 'search', args[0], args[1], '--out', archiveFolder, '--scrolls', values.scrolls || '12', '--read', values.read || '0', '-f', 'json'];
    if (values.profile) native.unshift('--profile', values.profile);
    for (const key of ['site', 'window']) if (values[key]) native.push(`--${key}`, values[key]);
    for (const key of ['resume', 'comments', 'download']) if (values[key]) native.push(`--${key}`);
    if (values.screenshot === false) native.push('--no-screenshot');
    if (values.compact) native.push('--compact');
    if (values.concurrency !== undefined) native.push('--concurrency', values.concurrency);
    const diagnosticsFile = values.compact ? path.join(archiveFolder, 'raw', `search-${randomUUID()}.log`) : undefined;
    const output = await hostCommand(native, diagnosticsFile);
    const result = JSON.parse(output);
    if (diagnosticsFile) console.log(JSON.stringify({ ...result, diagnostics_file: diagnosticsFile }));
    else {
      process.stdout.write(output);
      await lzLibrary([result, ...(result.sources || [])]);
      await lzScope(archiveFolder, [result, ...(result.sources || [])]);
    }
    if (['blocked', 'failed'].includes(result.status)) process.exitCode = 2;
  } else {
    const native = ['luz-crawl', 'batch', '--file', path.resolve(values.file), '--out', archiveFolder, '--concurrency', String(values.concurrency ?? DEFAULT_CONCURRENCY), '-f', 'json'];
    if (values.scrolls !== undefined) native.push('--scrolls', values.scrolls);
    if (values.profile) native.unshift('--profile', values.profile);
    for (const key of ['resume', 'comments', 'download', 'allow-write', 'compact']) if (values[key]) native.push(`--${key}`);
    if (values.screenshot === false) native.push('--no-screenshot');
    const diagnosticsFile = values.compact ? path.join(archiveFolder, 'raw', `batch-${randomUUID()}.log`) : undefined;
    const output = await hostCommand(native, diagnosticsFile);
    const result = JSON.parse(output);
    if (diagnosticsFile) console.log(JSON.stringify({ ...result, diagnostics_file: diagnosticsFile }));
    else process.stdout.write(output);
    if (result.status !== 'completed') process.exitCode = 2;
  }
}

main().catch((error) => { const failure = classifyFailure(error); print({ status: 'failed', error: failure.message, failure: failure.toJSON() }); process.exitCode = 1; });
