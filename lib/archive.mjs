import fs from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalURL } from './platforms.mjs';
import { experienceScore, experienceTerms } from './experience-query.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
// The Crawl output root (outside the skill folder); LUZ_CRAWL_OUTPUT or --out wins.
export const DEFAULT_OUTPUT = process.env.LUZ_CRAWL_OUTPUT || 'E:\\Skill输出\\Luz-Crawl';
const STATE_ROOT = fileURLToPath(new URL('../data/memory/', import.meta.url));
const LEGACY_STATE_ROOT = fileURLToPath(new URL('../opencli/memory/', import.meta.url));
let legacyChecked = false;
// Releases before 2026-10-30 kept local memory in opencli/memory/. Move it once; if a running silent browser still
// holds files there, keep using the old folder for now and try again on the next run.
export const stateRoot = () => {
  if (process.env.LUZ_CRAWL_STATE) return process.env.LUZ_CRAWL_STATE;
  if (!legacyChecked) {
    legacyChecked = true;
    if (!existsSync(STATE_ROOT) && existsSync(LEGACY_STATE_ROOT)) {
      try {
        mkdirSync(path.dirname(path.resolve(STATE_ROOT)), { recursive: true });
        renameSync(LEGACY_STATE_ROOT, STATE_ROOT);
        console.error('[luz-crawl] 本机记忆已从 opencli/memory/ 移到 data/memory/。');
      } catch {}
    }
  }
  return !existsSync(STATE_ROOT) && existsSync(LEGACY_STATE_ROOT) ? LEGACY_STATE_ROOT : STATE_ROOT;
};

export async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export function mergeItems(previous, incoming) {
  const records = new Map(previous.map((item) => [item.id || hash(item.url || item.text), item]));
  for (const item of incoming) {
    const id = item.id || hash(item.url || item.text);
    const old = records.get(id);
    if (!old || (item.text || '').length >= (old.text || '').length) records.set(id, { ...old, ...item, id });
  }
  return [...records.values()];
}

export function safeTitle(value) {
  return [...String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 64).join('').replace(/[. ]+$/, '') || '未命名网页';
}

// Layout (task_folder_v2): <output root>\NNN-主题\ is one task. Everything crawled and every machine record sits in its raw\
// folder; the summary HTML sits beside raw\ as NNN-主题.html. A page archive is <task>\raw\NNNN_标题\ with its files directly
// inside (content.json, manifest.json, identity.json, page.png, snapshots\, media\ and the readable NNNN_标题.html).
// Older task folders stay readable and continuable under their own names: NNN_主题 (underscore), a marker next to raw\
// (delivery_layout sibling_raw_v1) and page files inside <archive>\raw\. A task is recognised by its marker, never by its name.
export const TASK_LAYOUT = 'task_folder_v2';
export const LEGACY_TASK_LAYOUT = 'sibling_raw_v1';
export const ARCHIVE_LAYOUT = 'archive_html_v2';
export const LEGACY_ARCHIVE_LAYOUT = 'html_and_raw_v1';
export const MIGRATE_SCRIPT = fileURLToPath(new URL('../scripts/migrate_layout.py', import.meta.url));

export const pageNumber = (serial) => String(serial).padStart(4, '0');
// The leading number of a folder name; NNN-主题 and the older NNN_主题 both count, so a new task goes after every existing one.
const serialOf = (name) => Number(name.match(/^(\d+)[_-]/)?.[1] || 0);
const ignorableName = (name) => name.startsWith('.') || /^(desktop\.ini|thumbs\.db)$/i.test(name);

export async function allocationLock(directory, action) {
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.archive-allocation.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.writeFile(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Archive allocation lock is busy: ${lock}. Check for a live allocator before removing it.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); } finally { await fs.rm(lock); }
}

async function readJSONIfPresent(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readMarker(file) {
  const marker = await readJSONIfPresent(file);
  return marker?.schema_version === 1 && marker.kind === 'task_archive' ? marker : null;
}

// A task folder is recognised by its marker: <task>\raw\luz-task.json (task_folder_v2) or <task>\luz-task.json (sibling_raw_v1).
// Passing <task>\raw\ resolves to the task itself.
export async function findTaskArchive(directory) {
  const given = path.resolve(directory);
  const inner = await readMarker(path.join(given, 'raw', 'luz-task.json'));
  if (inner) return { ...inner, folder: given, layout: TASK_LAYOUT };
  const beside = await readMarker(path.join(given, 'luz-task.json'));
  if (!beside) return null;
  if (beside.delivery_layout === TASK_LAYOUT && path.basename(given).toLowerCase() === 'raw') return { ...beside, folder: path.dirname(given), layout: TASK_LAYOUT };
  return { ...beside, folder: given, layout: LEGACY_TASK_LAYOUT };
}

// The folder that numbers the tasks: the parent of a task folder (an older task sat one level deeper, in <root>\raw\).
export function outputRootOf(task) {
  const parent = path.dirname(task.folder);
  return task.layout === LEGACY_TASK_LAYOUT && path.basename(parent).toLowerCase() === 'raw' ? path.dirname(parent) : parent;
}

async function enclosingTask(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const task = await findTaskArchive(current);
    if (task) return task;
    if (current === path.dirname(current)) return null;
  }
}
export const findEnclosingTask = enclosingTask;

async function allocateTaskDirectoryUnlocked(root, title) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const loose = entries.filter((entry) => !entry.isDirectory() && !ignorableName(entry.name));
  if (loose.length) {
    throw new Error(`输出根目录 ${root} 里有 ${loose.length} 个散落文件（如 ${loose.slice(0, 3).map((entry) => entry.name).join('、')}）。新目录只放“序号-主题”文件夹，不会替您收拾旧文件；请先运行 py -X utf8 "${MIGRATE_SCRIPT}" --root "${root}" 查看迁移计划，确认后加 --apply。`);
  }
  // Highest number among the existing folders (new NNN-主题 and older NNN_主题 alike, also the tasks an unmigrated root keeps
  // under <root>\raw\) plus one; no gap is filled, no number reused.
  const legacyTasks = entries.some((entry) => entry.isDirectory() && entry.name === 'raw')
    ? (await fs.readdir(path.join(root, 'raw'), { withFileTypes: true }).catch(() => [])).filter((entry) => /^\d{3}[_-]/.test(entry.name))
    : [];
  let serial = [...entries, ...legacyTasks].reduce((highest, entry) => Math.max(highest, entry.isDirectory() ? serialOf(entry.name) : 0), 0) + 1;
  while (true) {
    const folder = path.join(root, `${String(serial).padStart(3, '0')}-${safeTitle(title)}`);
    try { await fs.mkdir(folder); return folder; }
    catch (error) { if (error.code !== 'EEXIST') throw error; serial += 1; }
  }
}

export async function createTaskArchive(out, title, { threadId = process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID, newTask = false } = {}) {
  const root = path.resolve(out);
  return allocationLock(root, async () => {
    const bindingFile = threadId ? path.join(stateRoot(), 'task-bindings', `${hash(threadId)}.json`) : null;
    const activeFile = path.join(stateRoot(), 'active-tasks', `${hash(root)}.json`);
    if (bindingFile && !newTask) {
      try {
        const binding = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
        if (binding.thread_id === threadId && binding.output_root && path.resolve(binding.output_root) === root) {
          const folder = path.resolve(binding.folder);
          if (path.dirname(folder) !== root) throw new Error(`Task binding escapes its output root: ${folder}`);
          if (await findTaskArchive(folder)) return folder;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!newTask && !bindingFile) {
      try {
        const active = JSON.parse(await fs.readFile(activeFile, 'utf8'));
        if (active.output_root && path.resolve(active.output_root) === root) {
          const folder = path.resolve(active.folder);
          if (path.dirname(folder) !== root) throw new Error(`Active task binding escapes its output root: ${folder}`);
          if (await findTaskArchive(folder)) return folder;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const folder = await allocateTaskDirectoryUnlocked(root, title);
    const task = { schema_version: 1, kind: 'task_archive', delivery_layout: TASK_LAYOUT, title: safeTitle(title), created_at: new Date().toISOString(), thread_id: threadId || null };
    await atomicWrite(path.join(folder, 'raw', 'luz-task.json'), task);
    await atomicWrite(activeFile, { output_root: root, folder, title: task.title, created_at: task.created_at });
    if (bindingFile) await atomicWrite(bindingFile, { thread_id: threadId, output_root: root, folder, title: task.title, created_at: task.created_at });
    // A task always has its summary page beside raw\ (title only until pages are crawled), so the folder is complete from the start.
    await recordReference({ base: folder });
    return folder;
  });
}

// Where an older (sibling_raw_v1) archive's readable HTML was delivered: the output root, two levels above its task folder.
export async function legacyDeliveryRoot(folder) {
  const task = await enclosingTask(folder);
  return task?.layout === LEGACY_TASK_LAYOUT ? outputRootOf(task) : path.dirname(path.dirname(path.resolve(folder)));
}

// Finds the folder holding an archive's manifest: the archive itself (current layout) or its raw\ child (older layout).
export async function locateArchive(folder) {
  const root = path.resolve(folder);
  for (const prefix of ['', 'raw/']) {
    try { await fs.access(path.join(root, prefix, 'manifest.json')); return { root, prefix, legacy: prefix !== '', dir: path.join(root, prefix) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Object.assign(new Error(`Not a LuzCrawl archive (manifest.json missing): ${root}`), { code: 'ENOENT' });
}

// The path of one file inside an archive: <archive>\name, else <archive>\raw\name (older layout). When neither exists the
// current-layout path comes back, so the caller's own read reports the missing file.
export async function archiveFile(folder, name) {
  const root = path.resolve(folder);
  for (const prefix of ['', 'raw']) {
    const file = path.join(root, prefix, name);
    try { await fs.access(file); return file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.join(root, name);
}

async function readArchiveRecord(folder, name) {
  for (const prefix of ['', 'raw/']) {
    const record = await readJSONIfPresent(path.join(folder, prefix, name));
    if (record) return { record, prefix };
  }
  return null;
}

export async function allocateRun(out, url, resume = false) {
  const given = path.resolve(out);
  const task = await findTaskArchive(given);
  // Inside a task the archives live in <task>\raw\; any other folder (a collection's source folder, a related-page folder)
  // holds its archives directly.
  const base = task ? path.join(task.folder, 'raw') : given;
  const sequenceRoot = task ? outputRootOf(task) : null;
  const identity = url === undefined ? null : canonicalURL(url);
  const lockRoot = sequenceRoot || base;
  return allocationLock(lockRoot, async () => {
    await fs.mkdir(base, { recursive: true });
    let folder, previous = null, serial = 0, highest = 0, recaptureOf = null, prefix = '';
    const sameURL = [];
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      highest = Math.max(highest, serialOf(entry.name));
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name);
      const found = await readArchiveRecord(candidate, 'manifest.json') || await readArchiveRecord(candidate, 'identity.json');
      if (identity && found?.record.canonical_url && canonicalURL(found.record.canonical_url) === identity) {
        sameURL.push({ candidate, record: found.record, prefix: found.prefix, serial: serialOf(entry.name) });
      }
    }
    // A URL that is captured again never touches the archive it already has: evidence that a stage, a report or a person
    // recorded by its hash stays as it was. The new capture is its own archive with the next serial and says which one it follows.
    // Only an explicit --resume continues (the newest) existing archive, to finish an interrupted capture or to append to it.
    if (sameURL.length) {
      const latest = sameURL.sort((a, b) => b.serial - a.serial)[0];
      if (resume) {
        folder = latest.candidate; previous = latest.record.files ? latest.record : null; serial = latest.serial; prefix = latest.prefix;
      } else {
        recaptureOf = path.basename(latest.candidate);
        console.error(`[LuzCrawl] 同一网址已有存档 ${latest.candidate}，本次另存为新存档，旧存档保持不变；要续接旧存档请加 --resume`);
      }
    }
    if (!folder && sequenceRoot) {
      // Page serials count up across all tasks of one output root.
      const sequenceFile = path.join(stateRoot(), 'delivery-sequences', `${hash(sequenceRoot)}.json`);
      try {
        const sequence = JSON.parse(await fs.readFile(sequenceFile, 'utf8'));
        if (!Number.isSafeInteger(sequence.last_serial) || sequence.last_serial < 0) throw new Error('Invalid delivery sequence.');
        highest = Math.max(highest, sequence.last_serial);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      serial = highest + 1;
      await atomicWrite(sequenceFile, { last_serial: serial });
    }
    serial ||= highest + 1;
    const resumedFolder = folder;
    folder ||= path.join(base, `${pageNumber(serial)}_未命名网页`);
    await fs.mkdir(path.join(folder, prefix), { recursive: true });
    await fs.writeFile(path.join(folder, '.capture.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }).catch((error) => { throw new Error(`Archive is locked: ${folder} (${error.code}). Check the recorded process before removing a stale lock.`); });
    await atomicWrite(path.join(folder, prefix, 'identity.json'), { canonical_url: identity, serial, ...(recaptureOf ? { recapture_of: recaptureOf } : {}) });
    // prefix is '' for the current layout and 'raw/' while an older archive is being continued; legacyOutput is where that older archive keeps its HTML.
    const run = { task: task?.folder || null, base, lockRoot, folder, previousFolder: resumedFolder, serial, previous, recaptureOf, prefix, legacyOutput: prefix ? await legacyDeliveryRoot(folder) : null, release: () => fs.rm(path.join(run.folder, '.capture.lock')) };
    return run;
  });
}

export async function nameRun(run, title) {
  const stem = `${pageNumber(run.serial)}_${safeTitle(title)}`;
  const target = path.join(run.base, stem);
  if (path.dirname(run.folder) !== run.base || path.dirname(target) !== run.base) throw new Error('Archive rename escapes the output root.');
  if (run.legacyOutput) {
    const delivery = path.join(run.legacyOutput, `${stem}.html`);
    try {
      const expected = run.previous?.delivery?.sha256 ?? run.previous?.files?.find((item) => item.path === `${stem}.html`)?.sha256;
      if (hash(await fs.readFile(delivery)) !== expected) throw new Error(`Refusing to replace existing HTML: ${delivery}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (target !== run.folder) await allocationLock(run.lockRoot, async () => {
    await fs.access(target).then(() => { throw new Error(`Refusing to replace existing archive: ${target}`); }, (error) => { if (error.code !== 'ENOENT') throw error; });
    try { await fs.rename(run.folder, target); run.folder = target; }
    catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code)) throw error;
      run.rename_warning = '存档文件夹改名受阻，保留原名称；页面 HTML 仍按序号和原标题命名';
    }
  });
  return `${stem}.html`;
}

export async function verifyArchive(folder) {
  const { root, legacy, dir } = await locateArchive(folder);
  const realRoot = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const failures = [];
  for (const entry of manifest.files || []) {
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(root + path.sep)) throw new Error('Manifest path escapes archive.');
    try {
      if (!(await fs.realpath(target)).startsWith(realRoot + path.sep)) throw new Error('Manifest file resolves outside archive.');
      if (await hashFile(target) !== entry.sha256) failures.push(entry.path);
    } catch { failures.push(entry.path); }
  }
  if (manifest.output_layout === ARCHIVE_LAYOUT) {
    if (!manifest.primary_file?.endsWith('.html') || path.basename(manifest.primary_file) !== manifest.primary_file) throw new Error('Invalid HTML path in manifest.');
    if (!(manifest.files || []).some((entry) => entry.path === manifest.primary_file)) failures.push(`html:${manifest.primary_file}`);
  } else if (manifest.output_layout === LEGACY_ARCHIVE_LAYOUT && legacy) {
    if (path.basename(path.dirname(root)) !== 'raw' || !manifest.primary_file?.endsWith('.html') || path.basename(manifest.primary_file) !== manifest.primary_file) throw new Error('Invalid HTML delivery path in manifest.');
    const output = await legacyDeliveryRoot(root);
    const delivery = path.join(output, manifest.primary_file);
    if (manifest.delivery && manifest.delivery.file !== manifest.primary_file) throw new Error('Invalid HTML delivery filename in manifest.');
    const expected = manifest.delivery?.sha256 ?? (manifest.files || []).find((entry) => entry.path === manifest.primary_file)?.sha256;
    try { if (hash(await fs.readFile(delivery)) !== expected) failures.push(`delivery:${manifest.primary_file}`); }
    catch { failures.push(`delivery:${manifest.primary_file}`); }
    for (const related of manifest.related_deliveries || []) {
      if (!related.file?.endsWith('.html') || path.basename(related.file) !== related.file) throw new Error('Invalid related delivery filename.');
      try { if (hash(await fs.readFile(path.join(output, related.file))) !== related.sha256) failures.push(`related_delivery:${related.file}`); }
      catch { failures.push(`related_delivery:${related.file}`); }
    }
  }
  if (!(manifest.files?.length) && !(Array.isArray(manifest.pruned_files) && manifest.pruned_files.length)) failures.push('manifest.files is empty');
  return { ok: failures.length === 0, failures, status: manifest.status, completeness: manifest.completeness };
}

// Regenerates the task's summary page after an archive changed.
export async function recordReference(run) {
  const task = await enclosingTask(run.base);
  if (!task) return null;
  const { writeCrawlSummary } = await import('./crawl-summary.mjs');
  return writeCrawlSummary(task.folder);
}

export async function recordExperience(event) {
  // One event file per platform, URL and query; a changed outcome is kept as previous_outcome.
  const identity = { platform: event.platform, url: event.canonical_url, query: event.query || '' };
  const id = hash(JSON.stringify(identity)).slice(0, 24);
  const file = path.join(stateRoot(), 'events', `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, `${JSON.stringify({ id, at: new Date().toISOString(), ...event }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    await atomicWrite(file, { ...previous, ...event, id, at: new Date().toISOString(), observations: (previous.observations || 1) + 1, ...(previous.status && previous.status !== event.status ? { previous_outcome: previous.status } : {}) });
  }
  await lzCompactEvents().catch(() => {});
  return id;
}

// Merges duplicate event files and keeps the 800 most recent groups once the folder passes 900 files.
export async function lzCompactEvents(force) {
  const dir = path.join(stateRoot(), 'events');
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
  if (!force && names.length <= 900) return { kept: names.length, removed: 0 };
  const lock = path.join(stateRoot(), 'events.compact.lock');
  try { await fs.writeFile(lock, String(process.pid), { flag: 'wx' }); }
  catch { return { skipped: 'locked' }; }
  try {
    const groups = new Map();
    for (const name of names) {
      let value;
      try { value = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); }
      catch { await fs.rm(path.join(dir, name), { force: true }); continue; }
      const key = JSON.stringify([value.platform, value.canonical_url || value.url || '', value.query || '']);
      const old = groups.get(key);
      if (!old) groups.set(key, { value, files: [name], observations: value.observations || 1 });
      else {
        old.files.push(name);
        old.observations += value.observations || 1;
        if ((value.at || '') > (old.value.at || '')) { old.previous_outcome = old.value.status; old.value = value; }
      }
    }
    const rows = [...groups.values()].sort((a, b) => (b.value.at || '').localeCompare(a.value.at || ''));
    const keep = rows.slice(0, 800);
    const drop = rows.slice(800);
    let removed = 0;
    for (const row of keep) {
      const id = hash(JSON.stringify({ platform: row.value.platform, url: row.value.canonical_url || row.value.url || '', query: row.value.query || '' })).slice(0, 24);
      const file = id + '.json';
      await atomicWrite(path.join(dir, file), { ...row.value, id, observations: row.observations, ...(row.previous_outcome && row.previous_outcome !== row.value.status ? { previous_outcome: row.previous_outcome } : {}) });
      for (const name of row.files) if (name !== file) { await fs.rm(path.join(dir, name), { force: true }); removed++; }
    }
    for (const row of drop) for (const name of row.files) { await fs.rm(path.join(dir, name), { force: true }); removed++; }
    return { kept: keep.length, removed };
  } finally { await fs.rm(lock, { force: true }); }
}

export function matchesQuery(value, query) {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every((term) => {
    const text = value.toLowerCase();
    return /^[a-z\d_-]+$/i.test(term) ? new RegExp(`(^|[^a-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`, 'i').test(text) : text.includes(term);
  });
}

export async function findExperience(query = '', platform, { category } = {}) {
  const root = stateRoot();
  const records = [];
  const keywords = new Map();
  for (const entry of await fs.readdir(path.join(root, 'events')).catch(() => [])) {
    if (!entry.endsWith('.json')) continue;
    const value = JSON.parse(await fs.readFile(path.join(root, 'events', entry), 'utf8'));
    if (!platform || value.platform === platform || value.platform === 'web') {
      const eventCategory = value.category || (value.route_kind === 'source_url_correction' ? 'route' : ['blocked', 'failed', 'awaiting_user'].includes(value.status) ? 'failure' : value.query ? 'keyword' : 'source');
      if (category && eventCategory !== category) continue;
      const score = experienceScore([value.query, value.route_query, value.lesson, value.stop_reason, value.canonical_url].join(' '), query);
      if (value.query && experienceScore(value.query, query) > 0) {
        const old = keywords.get(value.query) || { query: value.query, observations: 0, readable: 0, last_seen: '', relevance_score: experienceScore(value.query, query) };
        old.observations += value.observations || 1;
        if (value.valid_content === true && (!value.search_performed || value.candidates > 0)) old.readable += value.observations || 1;
        old.last_seen = old.last_seen > value.at ? old.last_seen : value.at;
        keywords.set(value.query, old);
      }
      if (score > 0 || (platform && value.route_kind === 'source_url_correction' && value.validated_url)) records.push({ ...value, category: eventCategory, relevance_score: score });
    }
  }
  const legacy = [];
  for (const name of ['search-keywords.md', 'search-skill-library.md', 'knowledge-index.md']) {
    const file = path.join(root, 'legacy', name);
    const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n');
    if (query) for (let index = lines.length - 1; index >= 0 && legacy.length < 12; index--) {
      if (experienceScore(lines[index], query) > 0) legacy.push({ file, line: index + 1, text: lines[index], current_verification_required: true });
    }
  }
  const seeds = JSON.parse(await fs.readFile(new URL('../data/experience/seeds.json', import.meta.url), 'utf8'));
  const hints = seeds.routes.map(item => ({ ...item, category: item.category || 'route', relevance_score: experienceScore([item.key, item.when, item.action, ...(item.tags || [])].join(' '), query), current_verification_required: true }))
    .filter(item => (!platform || item.platform === platform || item.platform === 'web') && (!category || item.category === category) && (!query || item.relevance_score > 0 || (platform && item.platform === platform)))
    .sort((a, b) => b.relevance_score - a.relevance_score || String(b.updated || '').localeCompare(String(a.updated || '')));
  return { query_terms: experienceTerms(query), route_hints: hints,
    events: records.sort((a, b) => b.relevance_score - a.relevance_score || b.at.localeCompare(a.at)).slice(0, 20),
    event_matches: records.length, events_truncated: records.length > 20,
    source_corrections: records.filter(event => event.route_kind === 'source_url_correction' && event.validated_url),
    keywords: [...keywords.values()].sort((a, b) => b.relevance_score - a.relevance_score || b.readable - a.readable || b.last_seen.localeCompare(a.last_seen)).slice(0, 20), legacy, state_root: root,
    note: '经验仅供选择查询与路线；失败也保留，重复命中不提升事实可信度，每次仍须核验当前页面。' };
}
