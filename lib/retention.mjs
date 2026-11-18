import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LARGE_DOWNLOAD = 8 * 1024 * 1024;

// Only this task-local directory holds finished, disposable research downloads.
// Media used by an offline delivery and files under active download live elsewhere.
async function cacheDirectory(taskRoot, create) {
  const root = await fs.realpath(taskRoot);
  const raw = path.join(root, 'raw');
  const dir = path.join(raw, 'download-cache');
  try {
    if (await fs.realpath(raw) !== raw) throw new Error('Task raw directory is redirected.');
    if (create) await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await fs.realpath(dir) !== dir || !(await fs.lstat(dir)).isDirectory()) throw new Error('Download cache is redirected.');
  } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
  return dir;
}

// Move a fully consumed mux input after its output exists. New names avoid
// collisions between archives and keep the original recording outside deliveries.
export async function cacheMuxInput(taskRoot, mediaDir, part) {
  const dir = await cacheDirectory(taskRoot, true);
  const media = await fs.realpath(mediaDir);
  const file = path.resolve(part.file);
  if (!media.startsWith(path.dirname(dir) + path.sep) || path.dirname(file) !== media || await fs.realpath(file) !== file) {
    throw new Error('Media input resolves outside its task archive.');
  }
  const target = path.join(dir, randomUUID() + path.extname(file));
  await fs.rename(file, target);
  return target;
}

export async function finishedDownloads(taskRoot) {
  const dir = await cacheDirectory(taskRoot, false);
  const candidates = [];
  if (!dir) return candidates;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || /\.(?:part|partial|tmp|crdownload)$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isFile() && stat.size >= LARGE_DOWNLOAD) candidates.push({ name: entry.name, stat });
  }
  return candidates;
}

export async function cleanupDownloads(taskRoot, candidates) {
  const result = { removed: 0, freed_bytes: 0, errors: [] };
  if (!candidates.length) return result;
  const dir = await cacheDirectory(taskRoot, false);
  if (!dir) return result;
  for (const entry of candidates) {
    if (path.basename(entry.name) !== entry.name) throw new Error('Invalid download cache filename.');
    const file = path.join(dir, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.ino !== entry.stat.ino || stat.size !== entry.stat.size ||
          stat.mtimeMs !== entry.stat.mtimeMs || await fs.realpath(file) !== file) continue;
      await fs.unlink(file);
      result.removed++;
      result.freed_bytes += stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') result.errors.push({ file: entry.name, error: error.message });
    }
  }
  return result;
}
