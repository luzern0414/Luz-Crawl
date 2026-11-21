import path from 'node:path';
import { capture } from './capture.mjs';
import { search } from './search.mjs';
import { withBrowser, cancelTask } from './browser-session.mjs';
import { doctor, profileFromArgs } from './doctor.mjs';
import { syncBrowserPreferences } from './browser-preferences.mjs';
import { preferences, pendingTasks, sites, loadTask } from './memory.mjs';
import { downloadArchive } from './download.mjs';
import { browserActions, readActions, ACTION_SCHEMA } from './browser-actions.mjs';
import { collect, refreshCollection } from './collect.mjs';
import { accessPolicy } from './execution.mjs';
import fs from 'node:fs/promises';
import { VERSION, API_VERSION } from './version.mjs';
import { retryVisibleIfIncomplete, withHeadlessSession, withVisibleFallbackOnHeadlessStartFailure } from './headless.mjs';
import { classifyFailure } from './failure.mjs';
import { archiveFile, createTaskArchive, findTaskArchive } from './archive.mjs';
import { batch, batchReceipt, DEFAULT_CONCURRENCY, readBatch } from './batch.mjs';
import { lzLibrary } from './site-library.mjs';
import { lzScope } from './scope.mjs';

// The browser commands the CLI entry runs through lib/host.mjs, one process per command. Each spec lists its positional
// and named arguments with defaults; the host records which options were given explicitly in __optionSources.
export const COMMANDS = [];
const cli = (spec) => COMMANDS.push(spec);
const defaults = await preferences();
const commonArgs = [
  { name: 'headless', type: 'boolean', default: true, help: 'Use Microsoft Edge silently by default; an explicit connected --profile selects that browser' },
  { name: 'out', type: 'string', default: defaults.output_dir, help: 'Output root or an existing LuzCrawl task folder (NNN-topic); crawled content goes under <task>/raw/, the summary page beside it' },
  { name: 'window', type: 'string', default: 'background', help: 'Inactive task tab in the selected browser; foreground is explicit' },
  { name: 'scrolls', type: 'int', default: 20, help: 'Maximum scroll rounds; exhausted budget means partial coverage' },
  { name: 'comments', type: 'boolean', default: false, help: 'Collect loaded comments and replies' },
  { name: 'download', type: 'boolean', default: false, help: 'Download observed post media through the browser before closing its page' },
  { name: 'resume', type: 'boolean', default: false, help: 'Verify and continue the newest archive of this URL instead of saving a new one (without it a URL captured again is its own archive and the old one stays untouched)' },
  { name: 'screenshot', type: 'boolean', default: true, help: 'Save a browser screenshot as evidence' },
];
const local = { access: 'read' };
const operate = async (page, options, kind, operations) => {
  if (kind !== 'download') return kind === 'search' ? search(page, options, operations) : kind === 'browser' ? browserActions(page, options, operations) : capture(page, options, operations);
  try { return await downloadArchive(options.directory, { ...options, page, operations, executionPolicy: operations.policy }); }
  catch (error) { const failure = classifyFailure(error); return {status:'failed',stop_reason:failure.code,error:failure.message}; }
};
async function run(kind, options) {
  if (options.access_mode !== 'authorized_browser' && options.access_mode !== 'public') options = { ...options, access_mode: !process.env.LUZ_HEADLESS_PROFILE && profileFromArgs(options.profile) ? 'authorized_browser' : 'public' };
  if (kind === 'browser') { const steps = await readActions(options); options = { ...options, steps, file: undefined }; }
  if (process.env.LUZ_VISIBLE_FALLBACK === '1') options = { ...options, _luz_visible_fallback: true };
  if (!process.env.LUZ_HEADLESS_PROFILE && options.__optionSources?.headless !== 'cli') options = { ...options, profile: profileFromArgs(options.profile) };
  if (options.headless && !process.env.LUZ_HEADLESS_PROFILE && (!options.profile || options.__optionSources?.headless === 'cli')) return headless(options, values => run(kind, values));
  if (!options.task && options.__optionSources?.out !== 'cli') {
    const saved = await syncBrowserPreferences(profileFromArgs(options.profile || defaults.browser_profile));
    options = { ...options, out: saved.output_dir };
  }
  if (!options.task && kind !== 'download' && !(kind === 'capture' && options.resume)) {
    const out = (await findTaskArchive(options.out))?.folder || await createTaskArchive(options.out, options.query || options.url || kind);
    options = { ...options, out };
  }
  const { _luz_visible_fallback, ...browserOptions } = options;
  const sessionOptions = _luz_visible_fallback ? { ...browserOptions, _luz_visible_fallback: true } : browserOptions;
  const result = await withBrowser(kind, sessionOptions, (page, values, taskKind, operations) => operate(page, values, taskKind, operations));
  if (!_luz_visible_fallback && !options.park_on_block && ['capture', 'search', 'download'].includes(kind)) return retryVisibleIfIncomplete(values => run(kind, values), browserOptions, result);
  return result;
}

async function headless(options, operation) {
  if (profileFromArgs()) throw new Error('--headless uses its own persistent profile; omit --profile.');
  return withVisibleFallbackOnHeadlessStartFailure(options, operation);
}

async function runCollect(options) {
  if (options.access_mode !== 'authorized_browser' && options.access_mode !== 'public') options = { ...options, access_mode: !process.env.LUZ_HEADLESS_PROFILE && profileFromArgs(options.profile) ? 'authorized_browser' : 'public' };
  if (process.env.LUZ_VISIBLE_FALLBACK === '1') options = { ...options, _luz_visible_fallback: true };
  if (!process.env.LUZ_HEADLESS_PROFILE && options.__optionSources?.headless !== 'cli') options = { ...options, profile: profileFromArgs(options.profile) };
  if (options.headless && !process.env.LUZ_HEADLESS_PROFILE && (!options.profile || options.__optionSources?.headless === 'cli')) return headless(options, runCollect);
  if (options.__optionSources?.out !== 'cli') options.out = (await syncBrowserPreferences(profileFromArgs(options.profile || defaults.browser_profile))).output_dir;
  options.out = (await findTaskArchive(options.out))?.folder || await createTaskArchive(options.out, options.input);
  const result = await collect(options.input, options);
  if (!options.compact) return result;
  const { status, folder, html_file, requested_tasks, attempted_tasks, verified_sources, awaiting_user, task_id, awaiting_reason, error, stop_reason } = result;
  return { status, folder, html_file, requested_tasks, attempted_tasks, verified_sources, awaiting_user, task_id, awaiting_reason, error, stop_reason,
    collection_file: Array.isArray(result.results) ? path.join(folder, 'collection.json') : undefined };
}

async function runBatch(options) {
  if (options.access_mode !== 'authorized_browser' && options.access_mode !== 'public') options = { ...options, access_mode: !process.env.LUZ_HEADLESS_PROFILE && profileFromArgs(options.profile) ? 'authorized_browser' : 'public' };
  options = { ...options, profile: profileFromArgs(options.profile) };
  const jobs = await readBatch(options);
  if (options.headless && !process.env.LUZ_HEADLESS_PROFILE && (!options.profile || options.__optionSources?.headless === 'cli')) return headless(options, runBatch);
  if (options.__optionSources?.out !== 'cli') options.out = (await syncBrowserPreferences(options.profile)).output_dir;
  options.out = (await findTaskArchive(options.out))?.folder || await createTaskArchive(options.out, 'batch');
  options.__optionSources = { ...options.__optionSources, out: 'cli' };
  const result = await batch(options, run, { jobs,
    retry: (kind, values, row) => retryVisibleIfIncomplete(next => run(kind, next), values, row),
  });
  const rows = result.results.flatMap(row => [...(row.previous_routes || []), row]).flatMap(row => [row, ...(row.sources || [])]);
  await lzLibrary(rows);
  await lzScope(options.out, rows);
  return options.compact ? batchReceipt(result) : result;
}

cli({ ...local, name: 'doctor', description: 'Scan LuzCrawl plugin and browser connection', args: [], func: doctor });
cli({ ...local, name: 'sites', description: 'List bundled and remembered websites', args: [], func: sites });
cli({ ...local, name: 'pending', description: 'List browser tasks awaiting manual login or verification', args: [], func: pendingTasks });
cli({ ...local, name: 'schema', description: 'Machine-readable browser action schema', args: [], func: () => ({ version: VERSION, api_version: API_VERSION, actions: ACTION_SCHEMA }) });
cli({ ...local, name: 'policy', description: 'View or save bounded platform pacing and retry settings', args: [{ name: 'file', type: 'string' }], func: async options => accessPolicy(options.file ? JSON.parse(await fs.readFile(options.file, 'utf8')) : undefined) });
cli({ ...local, name: 'collect', description: 'Plan browser searches and save all captured text and media in one HTML', args: [{name:'input',positional:true,required:true,type:'string'},{name:'platform',type:'string',help:'Comma-separated sites, or all verified sites'},{name:'file',type:'string',help:'Agent JSON search plan or links file'},{name:'read',type:'int',default:1},{name:'concurrency',type:'int'},{name:'compact',type:'boolean',default:false},{name:'name',type:'string'},...commonArgs.map(arg=>['comments','download'].includes(arg.name)?{...arg,default:true}:arg)], func: runCollect });
cli({ ...local, name: 'report', description: 'Refresh a saved collection after continuing its manual login tasks', args: [{name:'directory',positional:true,required:true,type:'string'}], func: options=>refreshCollection(options.directory) });
cli({ ...local, name: 'capture', description: 'Capture through Browser Bridge; retain the owned page when login needs the user', args: [{ name: 'url', positional: true, required: true, type: 'string' }, ...commonArgs], func: (options) => run('capture', options) });
cli({ ...local, access: 'write', name: 'batch', description: 'Run search and page jobs in one batch, with a shared queue per site', args: [{ name: 'file', type: 'string', required: true }, { name: 'concurrency', type: 'int', default: DEFAULT_CONCURRENCY }, { name: 'compact', type: 'boolean', default: false }, { name: 'allow-write', type: 'boolean', default: false }, ...commonArgs], func: runBatch });
cli({ ...local, name: 'search', description: 'Always search in a real browser, learn routes and read source pages', args: [{ name: 'platform', positional: true, required: true, type: 'string' }, { name: 'query', positional: true, required: true, type: 'string' }, { name: 'site', type: 'string', help: 'Domain for a public browser search' }, { name: 'read', type: 'int', default: 0, help: 'Number of source details to open (0-20)' }, {name:'compact',type:'boolean',default:false}, {name:'concurrency',type:'int',default:DEFAULT_CONCURRENCY}, ...commonArgs], func: async options => {
  const result = await run('search', options);
  if (!options.compact) return result;
  const rows = [result, ...(result.sources || [])];
  await lzLibrary(rows);
  await lzScope(result.search_archive || options.out, rows);
  const { status, search_performed, requested_sources, verified_sources, search_index, task_id, awaiting_reason, stop_reason, error } = result;
  const awaiting_user = rows.filter(row => row.status === 'awaiting_user' && row.task_id).map(row => ({ task_id: row.task_id, reason: row.awaiting_reason || row.stop_reason }));
  return { status, search_performed, candidate_count: result.candidates?.length ?? 0, requested_sources, verified_sources, search_index, awaiting_user,
    summary_file: result.summary_report?.file, task_id, awaiting_reason, stop_reason, error };
} });
cli({ ...local, name: 'continue', description: 'Resume the same owned browser task after manual login', args: [{ name: 'task', positional: true, required: true, type: 'string' }, {name:'headless',type:'boolean',default:true}], func: (options) => run('capture', options) });
cli({ ...local, name: 'cancel', description: 'Cancel a pending task and close only its owned tab', args: [{ name: 'task', positional: true, required: true, type: 'string' }], func: (options) => cancelTask(options.task) });
cli({ ...local, name: 'download', description: 'Reopen the source silently and download its observed media through the browser', args: [{ name: 'directory', positional: true, required: true, type: 'string' }, ...commonArgs.filter(arg=>['headless','window'].includes(arg.name))], func: async options => {
  const directory = path.resolve(options.directory);
  const content = JSON.parse(await fs.readFile(await archiveFile(directory,'content.json'),'utf8'));
  return run('download', {...options,directory,url:content.resolved_url || content.requested_url,out:path.dirname(path.dirname(directory))});
} });
cli({ ...local, access: 'write', name: 'browser', description: 'Run bounded browser actions on an owned page; writes need explicit authorization', args: [{ name: 'url', positional: true, required: true, type: 'string' }, { name: 'file', type: 'string' }, { name: 'steps', type: 'string', help: 'JSON action array; use this or --file' }, { name: 'allow-write', type: 'boolean', default: false }, ...commonArgs], func: (options) => run('browser', options) });
