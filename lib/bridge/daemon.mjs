// LuzCrawl bridge daemon: a loopback HTTP endpoint for the CLI and a WebSocket endpoint for the LuzCrawl extension.
// Each connected browser profile (contextId) gets its own extension connection; commands are relayed by id and
// settled by the extension's result message. Adapted from the OpenCLI 1.8.8 daemon (Apache-2.0).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket, OPEN } from './ws-server.mjs';
import { BRIDGE_HEADER, BRIDGE_PORT, BRIDGE_VERSION, DEFAULT_CONTEXT_ID, RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT, PROFILE_DISCONNECTED_HINT } from './constants.mjs';

const MAX_BODY = 1024 * 1024;
const LOG_LIMIT = 200;
const HEARTBEAT_MS = 15000;
const PROGRESS_TTL_MS = 10 * 60 * 1000;
const PROGRESS_MAX_TEXT = 240;

const finiteCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : undefined;
const shortText = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, PROGRESS_MAX_TEXT) : undefined;

function sanitizeProgress(body = {}) {
  const value = {
    ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
    ...(shortText(body.session) ? { session: shortText(body.session) } : {}),
    ...(shortText(body.platform) ? { platform: shortText(body.platform) } : {}),
    ...(shortText(body.query) ? { query: shortText(body.query) } : {}),
    ...(shortText(body.query_current) ? { query_current: shortText(body.query_current) } : {}),
    ...(shortText(body.stage) ? { stage: shortText(body.stage) } : {}),
    ...(shortText(body.status) ? { status: shortText(body.status) } : {}),
    ...(shortText(body.stop_reason) ? { stop_reason: shortText(body.stop_reason) } : {}),
    ...(body.access_mode === 'authorized_browser' || body.access_mode === 'public' ? { access_mode: body.access_mode } : {}),
  };
  for (const key of ['query_count', 'candidate_count', 'verified_count', 'comment_loaded', 'pending']) {
    const count = finiteCount(body[key]);
    if (count !== undefined) value[key] = count;
  }
  return value;
}

class CommandFailure extends Error {
  constructor(message, errorCode, errorHint, status = 400) {
    super(message);
    this.errorCode = errorCode;
    this.errorHint = errorHint;
    this.status = status;
  }
}

export function resolveProfileRoute({ requestedContextId, preferredContextId, connectedContextIds }) {
  const requested = requestedContextId?.trim() || undefined;
  const preferred = preferredContextId?.trim() || undefined;
  if (requested) {
    if (connectedContextIds.includes(requested)) return { ok: true, contextId: requested };
    return { ok: false, errorCode: 'profile_disconnected', error: `Browser profile "${requested}" is not connected.`, errorHint: PROFILE_DISCONNECTED_HINT };
  }
  if (preferred && connectedContextIds.includes(preferred)) return { ok: true, contextId: preferred };
  if (connectedContextIds.length === 1) return { ok: true, contextId: connectedContextIds[0] };
  if (connectedContextIds.length > 1) {
    return {
      ok: false,
      errorCode: 'profile_required',
      error: 'Multiple Browser Bridge profiles are connected; choose one with --profile.',
      errorHint: 'Run doctor to list connected browser profiles, then pass --profile <context_id>.',
    };
  }
  return { ok: false, errorCode: 'extension_not_connected', error: 'Extension not connected. Load the LuzCrawl extension from this skill\'s browser-extension folder.' };
}

export function startDaemon({ port = BRIDGE_PORT, host = '127.0.0.1', onExit = () => process.exit(0) } = {}) {
  const profiles = new Map();
  const pending = new Map();
  const progress = new Map();
  const logs = [];
  let resultUnknown = 0;

  const log = (level, msg) => {
    logs.push({ level, msg, ts: Date.now() });
    if (logs.length > LOG_LIMIT) logs.shift();
  };
  const activeProfiles = () => [...profiles.values()].filter((entry) => entry.ws.readyState === OPEN);
  const pruneProgress = () => {
    const cutoff = Date.now() - PROGRESS_TTL_MS;
    for (const [contextId, entry] of progress) if (!entry || entry.updated_at < cutoff) progress.delete(contextId);
  };
  const progressFor = (contextId) => {
    pruneProgress();
    const entry = contextId ? progress.get(contextId) : undefined;
    return entry ? { ...entry } : undefined;
  };
  const pendingFor = (contextId) => [...pending.values()].filter((entry) => !contextId || entry.contextId === contextId).length;
  const taskFor = (contextId) => {
    const task = progressFor(contextId);
    const pendingCount = pendingFor(contextId);
    if (!task && !pendingCount) return undefined;
    if (!task) return { active: true, stage: 'browser_command', pending: pendingCount, updated_at: Date.now() };
    return { ...task, active: task.active !== false || pendingCount > 0, pending: pendingCount };
  };
  const resolveConnection = (contextId, preferredContextId) => {
    const route = resolveProfileRoute({ requestedContextId: contextId, preferredContextId, connectedContextIds: activeProfiles().map((entry) => entry.contextId) });
    if (!route.ok) return route;
    const connection = profiles.get(route.contextId);
    if (connection?.ws.readyState === OPEN) return { ok: true, connection };
    return { ok: false, errorCode: 'profile_disconnected', error: `Browser profile "${route.contextId}" is not connected.`, errorHint: PROFILE_DISCONNECTED_HINT };
  };
  const settle = (id, entry, outcome) => {
    clearTimeout(entry.timer);
    pending.delete(id);
    for (const settler of entry.settlers) outcome.error ? settler.reject(outcome.error) : settler.resolve(outcome.data);
  };
  const register = (ws, rawContextId) => {
    const contextId = typeof rawContextId === 'string' && rawContextId.trim() ? rawContextId.trim() : DEFAULT_CONTEXT_ID;
    const previous = profiles.get(contextId);
    if (previous && previous.ws !== ws) previous.ws.close();
    for (const [key, entry] of profiles) if (entry.ws === ws && key !== contextId) profiles.delete(key);
    const connection = { contextId, ws, extensionVersion: null, extensionCompatRange: null, lastSeenAt: Date.now() };
    profiles.set(contextId, connection);
    return connection;
  };
  const unregister = (ws) => {
    for (const [contextId, connection] of profiles) {
      if (connection.ws !== ws) continue;
      profiles.delete(contextId);
      for (const [id, entry] of pending) {
        if (entry.contextId !== contextId) continue;
        const failure = entry.dispatched
          ? new CommandFailure(`Browser connection dropped after the ${entry.action} command was dispatched; it may have completed.`, RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT, 503)
          : new CommandFailure(`Browser profile "${contextId}" disconnected before command dispatch`, 'profile_disconnected', PROFILE_DISCONNECTED_HINT, 503);
        if (entry.dispatched) resultUnknown++;
        settle(id, entry, { error: failure });
      }
    }
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  const dispatch = async (body) => {
    const route = resolveConnection(body.contextId, body.preferredContextId);
    if (!route.ok) return { status: route.errorCode === 'profile_required' ? 409 : 503, data: { id: body.id, ok: false, errorCode: route.errorCode, error: route.error, ...(route.errorHint ? { errorHint: route.errorHint } : {}) } };
    const timeoutMs = typeof body.deadlineAt === 'number' && body.deadlineAt > 0 ? Math.max(1000, body.deadlineAt - Date.now()) : typeof body.timeout === 'number' && body.timeout > 0 ? body.timeout * 1000 : 120000;
    // A transport retry of an in-flight command attaches to it instead of dispatching it twice.
    const existing = pending.get(body.id);
    if (existing) return { status: 200, data: await new Promise((resolve, reject) => existing.settlers.push({ resolve, reject })) };
    const data = await new Promise((resolve, reject) => {
      const entry = { contextId: route.connection.contextId, action: typeof body.action === 'string' ? body.action : 'unknown', dispatched: false, settlers: [{ resolve, reject }] };
      entry.timer = setTimeout(() => {
        if (pending.get(body.id) !== entry) return;
        if (entry.dispatched) resultUnknown++;
        settle(body.id, entry, { error: new CommandFailure(`Browser ${entry.action} command timed out after ${Math.round(timeoutMs / 1000)}s; it may still complete in the browser.`, RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT, 408) });
      }, timeoutMs);
      pending.set(body.id, entry);
      const failBeforeDispatch = (error) => {
        if (pending.get(body.id) !== entry) return;
        log('warn', `dispatch failed for ${body.id}: ${error.message}`);
        settle(body.id, entry, { error: new CommandFailure(`Browser profile "${entry.contextId}" disconnected before command dispatch`, 'profile_disconnected', PROFILE_DISCONNECTED_HINT, 503) });
      };
      try {
        route.connection.ws.send(JSON.stringify(body), (error) => {
          if (error && !entry.dispatched) failBeforeDispatch(error);
        });
        entry.dispatched = true;
      } catch (error) {
        failBeforeDispatch(error);
      }
    });
    return { status: 200, data };
  };

  const handle = async (req, res) => {
    // Browsers always send Origin on cross-origin requests; only the extension (or no Origin, i.e. Node) may talk to us.
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) return json(res, 403, { ok: false, error: 'Forbidden: cross-origin request blocked' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (req.method === 'GET' && url.pathname === '/ping') return json(res, 200, { ok: true, service: 'luz-crawl' }, origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
    // A custom header cannot be attached by a web page's simple request, so scripted fetches from sites are refused.
    if (!req.headers[BRIDGE_HEADER]) return json(res, 403, { ok: false, error: `Forbidden: missing ${BRIDGE_HEADER} header` });
    if (req.method === 'GET' && url.pathname === '/status') {
      const route = resolveConnection(url.searchParams.get('contextId') || undefined, url.searchParams.get('preferredContextId') || undefined);
      const selectedContextId = route.connection?.contextId ?? url.searchParams.get('contextId') ?? undefined;
      return json(res, 200, {
        ok: true,
        service: 'luz-crawl',
        pid: process.pid,
        port,
        daemonVersion: BRIDGE_VERSION,
        extensionConnected: route.ok,
        extensionVersion: route.connection?.extensionVersion ?? undefined,
        contextId: selectedContextId,
        profileRequired: route.errorCode === 'profile_required',
        profileDisconnected: route.errorCode === 'profile_disconnected',
        profiles: activeProfiles().map((entry) => ({
          contextId: entry.contextId,
          extensionConnected: true,
          extensionVersion: entry.extensionVersion ?? undefined,
          extensionCompatRange: entry.extensionCompatRange ?? undefined,
          pending: [...pending.values()].filter((item) => item.contextId === entry.contextId).length,
          lastSeenAt: entry.lastSeenAt,
        })),
        pending: pending.size,
        task: taskFor(selectedContextId),
        commandResultUnknown: resultUnknown,
      });
    }
    if (req.method === 'GET' && url.pathname === '/logs') return json(res, 200, { ok: true, logs });
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      json(res, 200, { ok: true });
      setTimeout(shutdown, 100);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/progress') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
      const contextId = typeof body.contextId === 'string' && body.contextId.trim() ? body.contextId.trim() : undefined;
      if (!contextId) return json(res, 400, { ok: false, error: 'Missing progress contextId' });
      const previous = progress.get(contextId) || {};
      const next = { ...previous, ...sanitizeProgress(body), context_id: contextId, updated_at: Date.now() };
      if (next.active === false) next.finished_at = next.updated_at;
      progress.set(contextId, next);
      return json(res, 200, { ok: true, task: taskFor(contextId) });
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
      if (!body.id) return json(res, 400, { ok: false, error: 'Missing command id' });
      try {
        const { status, data } = await dispatch(body);
        return json(res, status, data);
      } catch (error) {
        return json(res, error.status ?? 400, { ok: false, error: error.message, ...(error.errorCode ? { errorCode: error.errorCode } : {}), ...(error.errorHint ? { errorHint: error.errorHint } : {}) });
      }
    }
    json(res, 404, { ok: false, error: 'Not found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ext' || (origin && !origin.startsWith('chrome-extension://'))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    let missedPongs = 0;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== OPEN) return clearInterval(heartbeat);
      if (missedPongs >= 2) {
        log('warn', 'extension heartbeat lost');
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      missedPongs++;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('pong', () => {
      missedPongs = 0;
    });
    ws.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (error) {
        log('warn', `malformed extension message: ${error.message}`);
        return;
      }
      if (msg.type === 'hello') {
        const connection = register(ws, msg.contextId);
        connection.extensionVersion = typeof msg.version === 'string' ? msg.version : null;
        connection.extensionCompatRange = typeof msg.compatRange === 'string' ? msg.compatRange : null;
        log('info', `extension profile connected: ${connection.contextId}`);
        return;
      }
      if (msg.type === 'log') {
        log(msg.level || 'info', `[ext] ${msg.msg}`);
        return;
      }
      if (msg.type === 'ping') return;
      for (const entry of profiles.values()) if (entry.ws === ws) entry.lastSeenAt = Date.now();
      const entry = pending.get(msg.id);
      if (entry) settle(msg.id, entry, { data: msg });
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      unregister(ws);
    });
    ws.on('error', () => {});
  });

  function shutdown() {
    for (const [id, entry] of pending) {
      settle(id, entry, { error: entry.dispatched
        ? new CommandFailure('Daemon shutting down before the command completed.', 'daemon_shutting_down', 'The extension journals command ids; a retry replays the result.', 503)
        : new CommandFailure(`Browser profile "${entry.contextId}" disconnected before command dispatch`, 'profile_disconnected', PROFILE_DISCONNECTED_HINT, 503) });
    }
    for (const entry of profiles.values()) entry.ws.close(1001);
    server.close(() => onExit());
    setTimeout(onExit, 1000).unref();
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
  return { server, ready, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { ready } = startDaemon();
  ready.catch((error) => {
    // Another daemon already owns the port: nothing to do.
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
}
