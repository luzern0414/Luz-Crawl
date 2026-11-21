// Stand-in browser operations for the preflight tests. The real batch coordinator runs these fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { batch, batchReceipt } from 'LUZ_BATCH_MODULE';

const [command, ...args] = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push([command, ...args]);
fs.writeFileSync(log, JSON.stringify(calls));
const out = (value, code = 0) => { console.log(JSON.stringify(value)); process.exitCode = code; };
const option = (name) => args[args.indexOf(name) + 1];
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let serial = 0;

function archive(task, label, url, sequence) {
  const folder = path.join(task, 'raw', `${calls.length}_${sequence}_${label}`);
  fs.mkdirSync(path.join(folder, 'snapshots'), { recursive: true });
  const content = path.join(folder, 'content.json'), snapshot = path.join(folder, 'snapshots', '0.json');
  fs.writeFileSync(snapshot, '{"text":"offline"}');
  fs.writeFileSync(content, JSON.stringify({ status: 'captured', captured_at: new Date().toISOString(), resolved_url: url, title: label,
    text: 'offline body ' + url, url_check: { valid_content: true }, completeness: { scope: 'rendered_body' } }));
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ files: [
    { path: 'content.json', sha256: sha(content) }, { path: 'snapshots/0.json', sha256: sha(snapshot) },
  ] }));
  return folder;
}

function execute(kind, { out: task, url, platform, query, read }) {
  const sequence = ++serial;
  if (kind === 'capture') {
    if (process.env.FAKE_THROW && url.includes(process.env.FAKE_THROW)) throw new Error('Fixture capture failed');
    if (process.env.FAKE_FAIL && url.includes(process.env.FAKE_FAIL)) {
      return { status: 'failed', stop_reason: 'rate_limited', url_check: { requested: url, valid_content: false } };
    }
    return { status: 'captured', folder: archive(task, 'page', url, sequence), title: 'page', url_check: { requested: url, valid_content: true } };
  }
  const fields = { platform, query, search_performed: true };
  if ((process.env.FAKE_EMPTY || '').split(',').includes(platform)) return { ...fields, status: 'partial', candidates: [], sources: [] };
  const base = `https://site${calls.length}-${sequence}.example`;
  const folder = read > 0 ? archive(task, 'hit', `${base}/read`, sequence) : null;
  return { ...fields, status: read > 0 ? 'partial' : 'captured',
    candidates: [{ url: `${base}/read`, title: 'read' }, { url: `${base}/other?utm_source=x`, title: 'other' }],
    sources: folder ? [{ status: 'captured', folder, url_check: { valid_content: true } }] : [] };
}

if (command === 'doctor') out(JSON.parse(process.env.FAKE_DOCTOR || '{"ready":false,"silent_ready":true}'));
else if (command === 'begin') {
  const folder = path.join(option('--out'), '001-task');
  fs.mkdirSync(path.join(folder, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'raw', 'luz-task.json'), JSON.stringify({ schema_version: 1, kind: 'task_archive', delivery_layout: 'task_folder_v2', title: args[0] }));
  out({ folder, title: args[0], status: 'ready' });
} else if (command === 'experience') {
  const lookups = JSON.parse(fs.readFileSync(option('--file'), 'utf8'));
  out({ lookups: lookups.map(row => ({ ...row, notes: row.query.includes('经验') ? [{ key: 'route-offline', kind: 'lesson', text: 'offline' }] : [] })) });
} else if (command === 'batch') {
  if (process.env.FAKE_BATCH_FAIL) out({ status: 'failed', error: 'fixture host unavailable' }, 1);
  else {
    const result = await batch({ file: option('--file'), out: option('--out'), concurrency: option('--concurrency'), screenshot: !args.includes('--no-screenshot') }, execute);
    out(await batchReceipt(result), result.status === 'completed' ? 0 : 2);
  }
} else out({ error: 'unknown' }, 1);
