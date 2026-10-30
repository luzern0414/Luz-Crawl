import fs from 'node:fs/promises';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalURL } from './platforms.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const DEFAULT_OUTPUT = path.resolve('outputs', 'luz-crawl');
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

export function rawRootFor(out) {
  const output = path.resolve(out);
  return path.basename(output).toLowerCase() === 'raw' ? output : path.join(output, 'raw');
}

export async function allocationLock(base, action) {
  await fs.mkdir(base, { recursive: true });
  const lock = path.join(path.dirname(base), `.${path.basename(base)}.archive-allocation.lock`);
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

async function allocateArchiveDirectoryUnlocked(base, title) {
  let entries = await fs.readdir(base, { withFileTypes: true });
  const loose = entries.filter((entry) => !entry.isDirectory());
  if (loose.length) {
    // Loose files are moved into their own numbered folder instead of blocking the run.
    const next = entries.reduce((highest, entry) => Math.max(highest, Number(entry.name.match(/^(\d+)_/)?.[1] || 0)), 0) + 1;
    const keep = path.join(base, `${String(next).padStart(3, '0')}_散落文件归档`);
    await fs.mkdir(keep, { recursive: true });
    for (const entry of loose) await fs.rename(path.join(base, entry.name), path.join(keep, entry.name));
    console.error(`[LuzCrawl] raw 根目录有散落文件，已移入 ${keep}：${loose.map((entry) => entry.name).join(', ')}`);
    entries = await fs.readdir(base, { withFileTypes: true });
  }
  let serial = entries.reduce((highest, entry) => Math.max(highest, Number(entry.name.match(/^(\d+)_/)?.[1] || 0)), 0) + 1;
  while (true) {
    const folder = path.join(base, `${String(serial).padStart(3, '0')}_${safeTitle(title)}`);
    try { await fs.mkdir(folder); return folder; }
    catch (error) { if (error.code !== 'EEXIST') throw error; serial += 1; }
  }
}

export async function allocateArchiveDirectory(out, title) {
  const base = rawRootFor(out);
  return allocationLock(base, () => allocateArchiveDirectoryUnlocked(base, title));
}

export async function findTaskArchive(directory) {
  const folder = path.resolve(directory);
  try {
    const marker = JSON.parse(await fs.readFile(path.join(folder, 'luz-task.json'), 'utf8'));
    return marker.schema_version === 1 && marker.kind === 'task_archive' ? { folder, ...marker } : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function taskDeliveryRoot(directory) {
  let folder = path.resolve(directory);
  while (true) {
    if ((await findTaskArchive(folder))?.delivery_layout === 'sibling_raw_v1') {
      if (path.basename(path.dirname(folder)).toLowerCase() !== 'raw') throw new Error('Task archive must be directly below raw/.');
      return path.dirname(path.dirname(folder));
    }
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

export async function deliveryRootForArchive(folder) {
  return await taskDeliveryRoot(folder) || path.dirname(path.dirname(path.resolve(folder)));
}

export async function createTaskArchive(out, title, { threadId = process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID, newTask = false } = {}) {
  const base = rawRootFor(out);
  return allocationLock(base, async () => {
    const bindingFile = threadId ? path.join(stateRoot(), 'task-bindings', `${hash(threadId)}.json`) : null;
    const activeFile = path.join(stateRoot(), 'active-tasks', `${hash(base)}.json`);
    if (bindingFile && !newTask) {
      try {
        const binding = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
        if (binding.thread_id === threadId && path.resolve(binding.raw_root) === base) {
          const folder = path.resolve(binding.folder);
          if (path.dirname(folder) !== base) throw new Error(`Task binding escapes its raw root: ${folder}`);
          if (await findTaskArchive(folder)) return folder;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!newTask && !bindingFile) {
      try {
        const active = JSON.parse(await fs.readFile(activeFile, 'utf8'));
        if (path.resolve(active.raw_root) !== base) throw new Error(`Active task binding does not match its raw root: ${active.raw_root}`);
        const folder = path.resolve(active.folder);
        if (path.dirname(folder) !== base) throw new Error(`Active task binding escapes its raw root: ${folder}`);
        if (await findTaskArchive(folder)) {
          if (bindingFile) await atomicWrite(bindingFile, { thread_id: threadId, raw_root: base, folder, title: active.title, created_at: active.created_at });
          return folder;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const folder = await allocateArchiveDirectoryUnlocked(base, title);
    const task = { schema_version: 1, kind: 'task_archive', delivery_layout: 'sibling_raw_v1', title: safeTitle(title), created_at: new Date().toISOString(), thread_id: threadId || null };
    await atomicWrite(path.join(folder, 'luz-task.json'), task);
    await atomicWrite(activeFile, { raw_root: base, folder, title: task.title, created_at: task.created_at });
    if (bindingFile) await atomicWrite(bindingFile, { thread_id: threadId, raw_root: base, folder, title: task.title, created_at: task.created_at });
    return folder;
  });
}

export async function allocateRun(out, url, resume = false) {
  const evidenceOutput = path.resolve(out);
  const output = await taskDeliveryRoot(evidenceOutput) || evidenceOutput;
  const base = path.join(evidenceOutput, 'raw');
  const identity = url === undefined ? null : canonicalURL(url);
  return allocationLock(output === evidenceOutput ? base : rawRootFor(output), async () => {
    await fs.mkdir(base, { recursive: true });
    let folder, previous = null, serial = 0, highest = 0;
    for (const directory of [base, output]) for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      highest = Math.max(highest, Number(entry.name.match(/^(\d+)_/)?.[1] || 0));
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      let record;
      for (const name of ['manifest.json', 'identity.json']) {
        try { record = JSON.parse(await fs.readFile(path.join(candidate, 'raw', name), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (identity && record?.canonical_url && canonicalURL(record.canonical_url) === identity) {
        if (folder) throw new Error('Duplicate URL archives found; resolve duplicates before resuming.');
        folder = candidate; previous = record.files ? record : null;
        serial = Number(entry.name.match(/^(\d+)_/)?.[1] || 0);
      }
    }
    if (folder && !resume) {
      console.error(`[LuzCrawl] 同一网址已有存档，自动续接：${folder}`);
      resume = true;
    }
    if (!folder && output !== evidenceOutput) {
      const sequenceFile = path.join(stateRoot(), 'delivery-sequences', `${hash(output)}.json`);
      try {
        const sequence = JSON.parse(await fs.readFile(sequenceFile, 'utf8'));
        if (!Number.isSafeInteger(sequence.last_serial) || sequence.last_serial < 0) throw new Error('Invalid delivery sequence.');
        highest = Math.max(highest, sequence.last_serial);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      serial = highest + 1;
      await atomicWrite(sequenceFile, { last_serial: serial });
    }
    serial ||= highest + 1;
    const previousFolder = folder;
    if (folder && path.dirname(folder) === output) {
      await fs.access(path.join(folder, '.capture.lock')).then(() => { throw new Error(`Archive is locked: ${folder}. Check the recorded process before removing a stale lock.`); }, (error) => { if (error.code !== 'ENOENT') throw error; });
      if (previous) {
        const integrity = await verifyArchive(folder);
        if (!integrity.ok) throw new Error(`Cannot resume a modified/incomplete archive: ${integrity.failures.join(', ')}`);
      }
      const target = path.join(base, path.basename(folder));
      await fs.access(target).then(() => { throw new Error(`Refusing to replace existing archive: ${target}`); }, (error) => { if (error.code !== 'ENOENT') throw error; });
      await fs.rename(folder, target);
      folder = target;
    }
    folder ||= path.join(base, `${String(serial).padStart(3, '0')}_未命名网页`);
    await fs.mkdir(path.join(folder, 'raw', 'snapshots'), { recursive: true });
    await fs.writeFile(path.join(folder, '.capture.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }).catch((error) => { throw new Error(`Archive is locked: ${folder} (${error.code}). Check the recorded process before removing a stale lock.`); });
    await atomicWrite(path.join(folder, 'raw', 'identity.json'), { canonical_url: identity, serial });
    const run = { output, base, folder, previousFolder, serial, previous, release: () => fs.rm(path.join(run.folder, '.capture.lock')) };
    return run;
  });
}

export async function nameRun(run, title) {
  const stem = `${String(run.serial).padStart(3, '0')}_${safeTitle(title)}`;
  const target = path.join(run.base, stem);
  if (path.dirname(run.folder) !== run.base || path.dirname(target) !== run.base) throw new Error('Archive rename escapes the output root.');
  const delivery = path.join(run.output, `${stem}.html`);
  try {
    const expected = run.previous?.delivery?.sha256 ?? run.previous?.files?.find((item) => item.path === `${stem}.html`)?.sha256;
    if (hash(await fs.readFile(delivery)) !== expected) throw new Error(`Refusing to replace existing HTML: ${delivery}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (target !== run.folder) await allocationLock(run.base, async () => {
    await fs.access(target).then(() => { throw new Error(`Refusing to replace existing archive: ${target}`); }, (error) => { if (error.code !== 'ENOENT') throw error; });
    try { await fs.rename(run.folder, target); run.folder = target; }
    catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code)) throw error;
      run.rename_warning = 'raw 证据目录改名受阻，保留原名称；交付 HTML 仍按序号和原标题命名';
    }
  });
  return `${stem}.html`;
}

export async function verifyArchive(folder) {
  const root = path.resolve(folder);
  const realRoot = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'raw', 'manifest.json'), 'utf8'));
  const failures = [];
  for (const entry of manifest.files || []) {
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(root + path.sep)) throw new Error('Manifest path escapes archive.');
    try {
      if (!(await fs.realpath(target)).startsWith(realRoot + path.sep)) throw new Error('Manifest file resolves outside archive.');
      if (hash(await fs.readFile(target)) !== entry.sha256) failures.push(entry.path);
    } catch { failures.push(entry.path); }
  }
  if (manifest.output_layout === 'html_and_raw_v1') {
    if (path.basename(path.dirname(root)) !== 'raw' || !manifest.primary_file?.endsWith('.html') || path.basename(manifest.primary_file) !== manifest.primary_file) throw new Error('Invalid HTML delivery path in manifest.');
    const delivery = path.join(await deliveryRootForArchive(root), manifest.primary_file);
    if (manifest.delivery && manifest.delivery.file !== manifest.primary_file) throw new Error('Invalid HTML delivery filename in manifest.');
    const expected = manifest.delivery?.sha256 ?? (manifest.files || []).find((entry) => entry.path === manifest.primary_file)?.sha256;
    try { if (hash(await fs.readFile(delivery)) !== expected) failures.push(`delivery:${manifest.primary_file}`); }
    catch { failures.push(`delivery:${manifest.primary_file}`); }
    for (const related of manifest.related_deliveries || []) {
      if (!related.file?.endsWith('.html') || path.basename(related.file) !== related.file) throw new Error('Invalid related delivery filename.');
      try { if (hash(await fs.readFile(path.join(await deliveryRootForArchive(root), related.file))) !== related.sha256) failures.push(`related_delivery:${related.file}`); }
      catch { failures.push(`related_delivery:${related.file}`); }
    }
  }
  if (!(manifest.files?.length) && !(Array.isArray(manifest.pruned_files) && manifest.pruned_files.length)) failures.push('manifest.files is empty');
  return { ok: failures.length === 0, failures, status: manifest.status, completeness: manifest.completeness };
}

export async function recordReference(run) {
  const { writeCrawlSummary } = await import('./crawl-summary.mjs');
  return writeCrawlSummary(path.dirname(run.base));
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

export async function findExperience(query = '', platform) {
  const root = stateRoot();
  const records = [];
  const keywords = new Map();
  for (const entry of await fs.readdir(path.join(root, 'events')).catch(() => [])) {
    if (!entry.endsWith('.json')) continue;
    const value = JSON.parse(await fs.readFile(path.join(root, 'events', entry), 'utf8'));
    if (!platform || value.platform === platform) {
      if (value.query && matchesQuery(value.query, query)) {
        const old = keywords.get(value.query) || { query: value.query, observations: 0, readable: 0, last_seen: '' };
        old.observations += value.observations || 1;
        if (value.status === 'captured' || value.candidates > 0) old.readable += value.observations || 1;
        old.last_seen = old.last_seen > value.at ? old.last_seen : value.at;
        keywords.set(value.query, old);
      }
      if (matchesQuery(JSON.stringify(value), query)) records.push(value);
    }
  }
  const legacy = [];
  for (const name of ['search-keywords.md', 'search-skill-library.md', 'knowledge-index.md']) {
    const file = path.join(root, 'legacy', name);
    const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n');
    if (query) for (let index = lines.length - 1; index >= 0 && legacy.length < 12; index--) {
      if (matchesQuery(lines[index], query)) legacy.push({ file, line: index + 1, text: lines[index], current_verification_required: true });
    }
  }
  const seeds = JSON.parse(await fs.readFile(new URL('../data/experience/seeds.json', import.meta.url), 'utf8'));
  return { route_hints: seeds.routes.filter((item) => !platform || item.platform === platform || item.platform === 'web'), events: records.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20), keywords: [...keywords.values()].sort((a, b) => b.readable - a.readable || b.last_seen.localeCompare(a.last_seen)).slice(0, 20), legacy, state_root: root, note: 'Saved experience orders browser routes and suggests keywords; every search still opens a real browser and verifies the current page.' };
}
