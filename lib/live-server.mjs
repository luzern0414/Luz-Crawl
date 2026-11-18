import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { atomicWrite, hash } from './archive.mjs';

// One session, one page command at a time. Never infer whether a timed-out write ran.
export async function createLiveServer({ directory, token, session, out, ttl = 900, dispatch, status, onExpire = () => {}, onClose = () => {} }) {
  await fs.mkdir(directory, { recursive: true });
  let busy = false, closing = false, lastUsed = Date.now(), count = 0;
  const opened = Date.now();
  const send = (res, code, body) => { res.writeHead(code, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(res, 401, { status:'failed', code:'unauthorized' });
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || req.method !== 'POST' || req.url !== '/command') return send(res, 403, { status:'failed', code:'invalid_request' });
    let message, acquired = false;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 262144) { send(res, 413, { code:'request_too_large' }); return; } }
      message = JSON.parse(body);
      if (!message || typeof message !== 'object' || message.session !== session || message.out !== out || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.id || '') || typeof message.op !== 'string') return send(res, 400, { code:'invalid_request' });
      if (message.op === 'status') return send(res, 200, { ...status(), busy, idle_seconds: Math.floor((Date.now()-lastUsed)/1000) });
      if (busy || closing) return send(res, 409, { status:'busy', code:'session_busy', retry_same_request_id:true });
      busy = true; acquired = true;
      const file = path.join(directory, `${message.id}.json`);
      const fingerprint = hash(JSON.stringify(message));
      const previous = await fs.readFile(file, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (previous) {
        if (previous.fingerprint !== fingerprint) return send(res, 409, { code:'request_id_conflict' });
        return send(res, previous.result ? 200 : 409, previous.result ? { ...previous.result, replayed:true } : { status:'outcome_unknown', code:'request_incomplete', retry_same_request_id:true });
      }
      if (!['close','verify'].includes(message.op) && ++count > 1000) return send(res, 409, { code:'session_request_limit', next_action:'Close this session after verifying any pending write.' });
      // Persist before dispatch. Do not save the request body, credentials or typed values.
      const record = { id:message.id, op:message.op, fingerprint, started_at:new Date().toISOString(), status:'started' };
      await atomicWrite(file, record);
      let result;
      const started = Date.now();
      try { result = await dispatch(message); }
      catch (error) { result = { status:'failed', error:error.message, failure:{ code:error.code || 'operation_failed', outcome_unknown:Boolean(error.outcome_unknown) } }; }
      result = { ...result, request_id:message.id, elapsed_ms:Date.now()-started };
      try { await atomicWrite(file, { ...record, status:'completed', result }); }
      catch {
        closing=true;
        send(res,500,{status:'outcome_unknown',request_id:message.id,code:'result_persistence_failed',next_action:'Inspect the started request record; this session is closing and will not replay the action.'});
        setImmediate(onExpire); return;
      }
      lastUsed = Date.now();
      send(res, 200, result);
      if(message.op==='close' && result.status==='closing') { closing=true; setImmediate(onClose); }
    } catch (error) { if (!res.headersSent) send(res, 400, { status:'failed', code:'request_error', error:error.message }); }
    finally { if (acquired) busy = false; }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setInterval(() => {
    if (!busy && !closing && (Date.now()-lastUsed >= ttl*1000 || Date.now()-opened >= 8*3600000)) { closing = true; onExpire(); }
  }, 1000);
  timer.unref();
  return {
    url:`http://127.0.0.1:${server.address().port}/command`,
    async close() { closing = true; clearInterval(timer); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
