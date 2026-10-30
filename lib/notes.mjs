import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, matchesQuery, stateRoot } from './archive.mjs';

// Local experience notes (notes.json in the state root): the user's preferences, lessons and facts that later
// sessions read back through `experience`. A note is keyed by a short topic; a later note on the same key replaces it.
export const lzCaps = { preference: 60, lesson: 120, fact: 120 };
const SEEDS = new URL('../data/experience/seeds.json', import.meta.url);
const lzToday = () => new Date().toISOString().slice(0, 10);
const lzNorm = (value) => String(value || '').replace(/[\s\p{P}]+/gu, '').toLowerCase();
const lzPriv = /1[3-9]\d{9}|[\w.+-]+@[\w-]+\.[\w.]+|wxid_\w+|微信号\s*[:：]?\s*\w|[A-Za-z]:\\Users\\|\/Users\/[^/\s]+|(?:password|passwd|cookie|token|secret|api[_-]?key|密码)\s*[:=：]\s*\S/i;
const PREFERENCE_PUBLIC = '--public is for lessons and facts that help every user; personal preferences stay local.';

async function lzNotesLoad() {
  const file = path.join(stateRoot(), 'notes.json');
  let doc;
  try { doc = JSON.parse(await fs.readFile(file, 'utf8')); } catch { doc = {}; }
  const notes = (doc.notes || doc.entries || []).map((note) => ({
    key: String(note.key),
    kind: note.kind || 'lesson',
    text: note.text,
    ...(note.why ? { why: note.why } : {}),
    ...(note.platform ? { platform: note.platform } : {}),
    uses: note.uses || 1,
    first_seen: String(note.first_seen || note.created || lzToday()).slice(0, 10),
    last_confirmed: String(note.last_confirmed || lzToday()).slice(0, 10),
    ...(note.previous ? { previous: typeof note.previous === 'string' ? { text: note.previous, replaced_at: String(note.last_confirmed || lzToday()).slice(0, 10) } : note.previous } : {}),
  }));
  return { file, doc: { schema_version: '1.0', caps: lzCaps, notes } };
}

function lzCapNotes(doc) {
  const removed = [];
  for (const kind of Object.keys(lzCaps)) {
    const group = doc.notes.filter((note) => note.kind === kind);
    if (group.length > lzCaps[kind]) {
      const drop = group.sort((a, b) => a.uses - b.uses || a.last_confirmed.localeCompare(b.last_confirmed)).slice(0, group.length - lzCaps[kind]);
      removed.push(...drop.map((note) => note.key));
      doc.notes = doc.notes.filter((note) => !drop.includes(note));
    }
  }
  return removed;
}

export async function lzNote(values) {
  const kind = values.kind || 'lesson';
  if (!['preference', 'lesson', 'fact'].includes(kind)) throw new Error('--kind must be preference, lesson or fact.');
  if (values.public && kind === 'preference') throw new Error(PREFERENCE_PUBLIC);
  if (values.public && !String(values.when || '').trim()) throw new Error('--public needs --when "situation": say when the hint applies, not what the task was.');
  const text = String(values.text ?? values.note ?? '').trim();
  if (!text || text.length > 600) throw new Error('--text must be 1-600 characters.');
  if (!values.key || !String(values.key).trim()) throw new Error('--key is required: a short topic name that later notes on the same topic reuse.');
  if (lzPriv.test(text) || lzPriv.test(values.why || '')) throw new Error('Notes must not contain phone numbers, emails, WeChat IDs, personal paths, passwords, cookies or tokens.');
  const key = String(values.key).trim();
  const today = lzToday();
  const { file, doc } = await lzNotesLoad();
  const old = doc.notes.find((note) => note.key === key);
  const twin = !old && doc.notes.find((note) => lzNorm(note.text) === lzNorm(text));
  let status;
  if (twin) {
    twin.uses++;
    twin.last_confirmed = today;
    status = 'confirmed';
  } else if (old) {
    const changed = old.text !== text;
    if (changed) old.previous = { text: old.text, replaced_at: today };
    Object.assign(old, { kind, text, ...(values.why ? { why: values.why } : {}), ...(values.platform ? { platform: values.platform } : {}), uses: old.uses + 1, last_confirmed: today });
    status = changed ? 'replaced' : 'confirmed';
  } else {
    doc.notes.unshift({ key, kind, text, ...(values.why ? { why: values.why } : {}), ...(values.platform ? { platform: values.platform } : {}), uses: 1, first_seen: today, last_confirmed: today });
    status = 'added';
  }
  const removed = lzCapNotes(doc);
  await atomicWrite(file, doc);
  const note = doc.notes.find((item) => item.key === (twin ? twin.key : key));
  const published = values.public ? await lzPublic(note, values) : undefined;
  return { status, note, removed, ...(published ? { public: published } : {}) };
}

// A public note becomes a keyed route hint in the shipped seeds.json (at most 60 keyed routes, oldest dropped first).
async function lzPublic(note, values) {
  if (note.kind === 'preference') throw new Error(PREFERENCE_PUBLIC);
  const doc = JSON.parse(await fs.readFile(SEEDS, 'utf8'));
  const route = { key: note.key, platform: values.platform || note.platform || 'web', when: String(values.when || note.why || note.key).trim(), action: note.text, updated: lzToday() };
  if (lzPriv.test(route.when)) throw new Error('--when must not contain personal data.');
  const index = doc.routes.findIndex((item) => item.key === note.key || (!item.key && item.platform === route.platform && lzNorm(item.when) === lzNorm(route.when)));
  const status = index >= 0 ? 'replaced' : 'added';
  if (index >= 0) doc.routes[index] = route;
  else doc.routes.push(route);
  const keyed = doc.routes.filter((item) => item.key);
  if (keyed.length > 60) {
    const drop = keyed.sort((a, b) => String(a.updated || '').localeCompare(String(b.updated || ''))).slice(0, keyed.length - 60);
    doc.routes = doc.routes.filter((item) => !drop.includes(item));
  }
  await fs.writeFile(SEEDS, `${JSON.stringify(doc, null, 2)}\n`);
  return { status, file: 'data/experience/seeds.json', route };
}

export async function lzNotesList(kind) {
  const { doc } = await lzNotesLoad();
  return doc.notes.filter((note) => !kind || note.kind === kind);
}

export async function lzNotesPrune() {
  const { file, doc } = await lzNotesLoad();
  const removed = lzCapNotes(doc);
  const old = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const stale = doc.notes.filter((note) => note.last_confirmed < old).map((note) => note.key);
  await atomicWrite(file, doc);
  return { removed, stale_candidates: stale, counts: Object.fromEntries(Object.keys(lzCaps).map((kind) => [kind, doc.notes.filter((note) => note.kind === kind).length])) };
}

export async function lzNotesCheck() {
  const { doc } = await lzNotesLoad();
  const errors = [];
  const keys = new Set();
  const texts = new Map();
  for (const note of doc.notes) {
    for (const field of ['key', 'kind', 'text', 'uses', 'first_seen', 'last_confirmed']) if (note[field] === undefined) errors.push(`${note.key}: missing ${field}`);
    if (keys.has(note.key)) errors.push(`duplicate key ${note.key}`);
    else keys.add(note.key);
    const text = lzNorm(note.text);
    if (texts.has(text)) errors.push(`duplicate text: ${note.key} = ${texts.get(text)}`);
    else texts.set(text, note.key);
    if (lzPriv.test(note.text)) errors.push(`${note.key}: personal data`);
  }
  for (const kind of Object.keys(lzCaps)) {
    const count = doc.notes.filter((note) => note.kind === kind).length;
    if (count > lzCaps[kind]) errors.push(`${kind} over cap ${count}/${lzCaps[kind]}`);
  }
  const seeds = JSON.parse(await fs.readFile(SEEDS, 'utf8'));
  const routeKeys = new Set();
  for (const route of seeds.routes) {
    if (route.key) {
      if (routeKeys.has(route.key)) errors.push(`seeds.json duplicate key ${route.key}`);
      else routeKeys.add(route.key);
    }
    if (lzPriv.test(`${route.action} ${route.when}`)) errors.push(`seeds.json personal data in ${route.key || route.when}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    counts: Object.fromEntries(Object.keys(lzCaps).map((kind) => [kind, `${doc.notes.filter((note) => note.kind === kind).length}/${lzCaps[kind]}`])),
    public_routes: seeds.routes.length,
  };
}

// Notes shown by `experience`: every preference, plus lessons and facts matching the query, for the platform or none.
export async function lzNotes(query, platform) {
  const { doc } = await lzNotesLoad();
  return doc.notes.filter((note) => (!platform || !note.platform || note.platform === platform) && (note.kind === 'preference' || !query || matchesQuery(`${note.key} ${note.text}`, query)));
}
