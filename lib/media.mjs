import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateURL } from './platforms.mjs';
import { stateRoot } from './archive.mjs';
import { OperationError, httpFailure } from './failure.mjs';

export function privateAddress(address) {
  if (isIP(address) === 6) return !/^[23][\da-f]{3}:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !isIP(address) || a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b);
}

export function validateMediaURL(value, source) {
  const url = validateURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((host === 'localhost' || isIP(host) && privateAddress(host)) && url.origin !== validateURL(source).origin) throw new Error('A public page cannot download from another local origin.');
  return url.href;
}

export async function luzFetchExtensionMedia(url, sourceURL, source, allowLocal, page, options) {
  const maxBytes = options.maxBytes || 250 * 1024 * 1024;
  let opened;
  try {
    opened = await page.fetchMedia({ op: 'open', mediaUrl: url.href, sourceUrl: sourceURL.href, maxBytes, credentials: options.credentials === 'omit' ? 'omit' : 'include', timeoutMs: options.timeoutMs || 60000 });
  } catch {
    return null;
  }
  if (!opened?.streamId) {
    if (!opened || [401, 403].includes(opened.status)) return null;
    if (opened.error) throw new OperationError('media_unavailable', opened.error);
    throw httpFailure({ status: opened.status, headers: new Headers(opened.headers || {}) });
  }
  const streamId = opened.streamId;
  const cancel = () => page.fetchMedia({ op: 'cancel', streamId }).catch(() => {});
  const length = Number(opened.headers?.['content-length']) || 0;
  let finalURL;
  if (/^text\/html$/i.test(opened.mime || '')) { await cancel(); return null; }
  try {
    finalURL = validateURL(validateMediaURL(opened.finalUrl || url.href, source));
    const finalAddresses = await lookup(finalURL.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!finalAddresses.length || !(allowLocal && finalURL.origin === sourceURL.origin) && finalAddresses.some(({ address }) => privateAddress(address))) throw new Error('Media redirect must resolve to public addresses.');
    options.signal?.throwIfAborted();
  } catch (error) { await cancel(); throw error; }
  let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        options.signal?.throwIfAborted();
        const chunk = await page.fetchMedia({ op: 'read', streamId, chunkBytes: 4194304 });
        const data = Buffer.from(chunk.data || '', 'base64');
        bytes += data.length;
        if (bytes > maxBytes) throw new Error('Browser media exceeds its size limit.');
        if (data.length) controller.enqueue(data);
        if (chunk.done) controller.close();
      } catch (error) {
        await cancel();
        controller.error(error);
      }
    },
    cancel,
  });
  return { ok:true, status:opened.status, headers:new Headers({'content-type':opened.mime || '', ...(length ? {'content-length':String(length)} : {})}), body, browser_download:{via:'extension_fetch',final_url:finalURL.href} };
}

export async function fetchBrowserMedia(value, source, page, options = {}) {
  const url = validateURL(validateMediaURL(value, source));
  const sourceURL = validateURL(source);
  const sourceHost = sourceURL.hostname.replace(/^\[|\]$/g, '');
  const allowLocal = url.origin === sourceURL.origin && (sourceHost === 'localhost' || isIP(sourceHost) && privateAddress(sourceHost));
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || !allowLocal && addresses.some(({ address }) => privateAddress(address))) throw new Error('Media host must resolve to public addresses.');
  if (!page?.downloadMedia) throw new Error('Media downloads require the LuzCrawl browser extension.');
  options.signal?.throwIfAborted();
  if (page.fetchMedia) {
    const fetched = await luzFetchExtensionMedia(url, sourceURL, source, allowLocal, page, options);
    if (fetched) return fetched;
  }
  const name = randomUUID();
  const result = await page.downloadMedia(url.href, sourceURL.href, { filename: 'luz-crawl/' + name, timeoutMs: options.timeoutMs || 180000, maxBytes: options.maxBytes || 250 * 1024 * 1024 });
  if (!result.downloaded) {
    const status = { SERVER_FORBIDDEN: 403, SERVER_UNAUTHORIZED: 401, SERVER_FAILED: 503 }[result.error];
    if (status) throw httpFailure({status, headers:new Headers()});
    throw new OperationError('media_unavailable', result.error || 'Browser download did not complete.');
  }
  const file = await fs.realpath(result.filename);
  const managedRoot = path.resolve(stateRoot(), 'browser-downloads') + path.sep;
  const namedFile = path.basename(file) === name && path.basename(path.dirname(file)) === 'luz-crawl';
  if (!file.startsWith(managedRoot) && !namedFile) throw new Error('Browser returned a file outside its managed download directory.');
  const discard = () => fs.rm(file, { force: true });
  try {
    const finalURL = validateURL(validateMediaURL(result.finalUrl || url.href, source));
    const finalAddresses = await lookup(finalURL.hostname.replace(/^\[|\]$/g, ''), { all: true });
    if (!finalAddresses.length || !(allowLocal && finalURL.origin === sourceURL.origin) && finalAddresses.some(({ address }) => privateAddress(address))) throw new Error('Media redirect must resolve to public addresses.');
    const stat = await fs.stat(file);
    if (!stat.isFile() || !stat.size || stat.size > (options.maxBytes || 250 * 1024 * 1024)) throw new Error('Browser media is empty or exceeds its size limit.');
    if (result.danger !== 'safe') throw new Error('Browser did not mark this download safe.');
    options.signal?.throwIfAborted();
    const input = createReadStream(file);
    input.once('close', () => { void discard().catch(() => {}); });
    return { ok:true, status:200, headers:new Headers({'content-type':result.mime || '', 'content-length':String(stat.size)}), body:Readable.toWeb(input), browser_download:{id:result.id,final_url:finalURL.href,bytes:stat.size} };
  } catch (error) { await discard(); throw error; }
}

