// CLI side of the LuzCrawl bridge: starts the daemon on demand, relays commands to the extension and exposes the
// small Page API the capture code uses. Adapted from the OpenCLI 1.8.8 browser client (Apache-2.0).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_HEADER, BRIDGE_URL, BRIDGE_VERSION, RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT } from './constants.mjs';
import { generateStealthJs, waitForDomStableJs } from './stealth.mjs';

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const EXTENSION_OP_MARGIN_MS = 15000;
const HTTP_MARGIN_MS = 10000;
const CONNECT_TIMEOUT_SECONDS = 10;
const TRANSPORT_MAX_ATTEMPTS = 4;
const PRE_DISPATCH_CODES = new Set(['extension_not_connected', 'profile_disconnected']);
const UNKNOWN_OUTCOME_CODES = new Set([RESULT_UNKNOWN_CODE, 'command_lost', 'result_evicted']);
const PRE_CONNECT_CODES = new Set(['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']);
const DAEMON_SCRIPT = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserCommandError extends Error {
  constructor(message, code, hint) {
    super(message);
    this.name = 'BrowserCommandError';
    this.code = code;
    this.hint = hint;
  }
}

export class BrowserConnectError extends Error {
  constructor(message, hint, kind = 'unknown') {
    super(message);
    this.name = 'BrowserConnectError';
    this.code = 'BROWSER_CONNECT';
    this.hint = hint;
    this.kind = kind;
  }
}

const TRANSIENT_PATTERNS = ['Extension disconnected', 'Extension not connected', 'attach failed', 'Detached while handling command', 'Debugger is not attached to the tab', 'no longer exists', 'No tab with id', 'CDP connection', 'Daemon command failed', 'No window with id'];
const CODE_ADVICE = {
  attach_failed: { kind: 'extension-transient', delayMs: 1500 },
  tab_gone: { kind: 'extension-transient', delayMs: 1500 },
  target_navigated: { kind: 'target-navigation', delayMs: 200 },
  detached_mid_command: { kind: 'non-retryable', delayMs: 0 },
  cdp_timeout: { kind: 'non-retryable', delayMs: 0 },
};

export function classifyBrowserError(error) {
  if (typeof error?.code === 'string' && CODE_ADVICE[error.code]) return CODE_ADVICE[error.code];
  const message = error instanceof Error ? error.message : String(error);
  if (TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern))) return { kind: 'extension-transient', delayMs: 1500 };
  if (message.includes('Inspected target navigated or closed') || (message.includes('-32000') && /target|context/i.test(message))) return { kind: 'target-navigation', delayMs: 200 };
  return { kind: 'non-retryable', delayMs: 0 };
}

export async function requestDaemon(pathname, { timeout = 2000, headers, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(`${BRIDGE_URL}${pathname}`, { ...init, headers: { [BRIDGE_HEADER]: '1', ...headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDaemonStatus({ contextId, preferredContextId, timeout = 2000 } = {}) {
  try {
    const query = new URLSearchParams({ ...(contextId ? { contextId } : {}), ...(preferredContextId ? { preferredContextId } : {}) }).toString();
    const res = await requestDaemon(`/status${query ? `?${query}` : ''}`, { timeout });
    if (!res.ok) return null;
    const status = await res.json();
    return status?.service === 'luz-crawl' ? status : null;
  } catch {
    return null;
  }
}

// Progress is best-effort: a disconnected popup or daemon must never change the
// result of a browser read. The bridge keeps only a short-lived, sanitized task
// snapshot for the extension status card.
export async function updateDaemonProgress(progress, { timeout = 800 } = {}) {
  if (!progress?.contextId) return null;
  try {
    const res = await requestDaemon('/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(progress),
      timeout,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getDaemonHealth(options) {
  const status = await fetchDaemonStatus(options);
  if (!status) return { state: 'stopped', status: null };
  if (status.profileRequired) return { state: 'profile-required', status };
  if (status.profileDisconnected) return { state: 'profile-disconnected', status };
  if (!status.extensionConnected) return { state: 'no-extension', status };
  return { state: 'ready', status };
}

export function spawnDaemon() {
  const child = spawn(process.execPath, [DAEMON_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export async function stopDaemon() {
  try {
    const res = await requestDaemon('/shutdown', { method: 'POST', timeout: 3000 });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForStop(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if ((await getDaemonHealth()).state === 'stopped') return true;
  }
  return false;
}

// Starts (or replaces an outdated) daemon and waits for the requested profile's extension to connect.
export async function ensureBridgeReady({ timeoutSeconds = CONNECT_TIMEOUT_SECONDS, contextId, preferredContextId } = {}) {
  let health = await getDaemonHealth({ contextId, preferredContextId });
  if (health.status && health.status.daemonVersion !== BRIDGE_VERSION) {
    const stopped = (await stopDaemon()) && (await waitForStop(3000));
    if (!stopped && Number.isInteger(health.status.pid)) {
      try {
        process.kill(health.status.pid);
      } catch {}
      await waitForStop(2000);
    }
    health = { state: 'stopped', status: null };
  }
  if (health.state === 'ready') return health;
  if (health.state === 'profile-required') throw connectError(health, contextId);
  if (health.state === 'stopped') spawnDaemon();
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    await sleep(200);
    health = await getDaemonHealth({ contextId, preferredContextId });
    if (health.state === 'ready') return health;
  }
  throw connectError(health, contextId);
}

function connectError(health, contextId) {
  if (health.state === 'profile-required') return new BrowserConnectError('Multiple Browser Bridge profiles are connected', 'Pass --profile <context_id>; doctor lists the connected profiles.', 'profile-required');
  if (health.state === 'profile-disconnected') return new BrowserConnectError(`Browser profile "${contextId ?? health.status?.contextId ?? 'unknown'}" is not connected`, 'Open that browser profile and make sure the LuzCrawl extension is enabled.', 'profile-disconnected');
  if (health.state === 'no-extension') return new BrowserConnectError('Browser Bridge extension not connected', 'Open Edge with the LuzCrawl extension loaded from this skill\'s browser-extension folder (edge://extensions, Developer mode, Load unpacked).', 'extension-not-connected');
  return new BrowserConnectError('Failed to start the LuzCrawl bridge daemon', `Run node ${DAEMON_SCRIPT} manually and check that port ${new URL(BRIDGE_URL).port} is free.`, 'daemon-not-running');
}

function isPreConnectError(error) {
  const queue = [error];
  const seen = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && PRE_CONNECT_CODES.has(current.code)) return true;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return false;
}

let idCounter = 0;
const nextId = () => `luz_${process.pid}_${Date.now()}_${++idCounter}`;

// Same id across transport retries: the daemon attaches to an in-flight id and the extension journals results, so a
// resend never executes twice. Only pre-dispatch and transient extension errors are retried.
async function sendCommandRaw(action, params) {
  const base = Number(process.env.LUZ_BROWSER_COMMAND_TIMEOUT) > 0 ? Number(process.env.LUZ_BROWSER_COMMAND_TIMEOUT) : DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const timeoutSeconds = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? Math.max(base, Math.ceil((params.timeoutMs + EXTENSION_OP_MARGIN_MS) / 1000)) : base;
  const deadlineAt = Date.now() + timeoutSeconds * 1000;
  const { contextId, preferredContextId } = params;
  let id = nextId();
  let ensured = false;
  let semanticRetried = false;
  const ensure = () => ensureBridgeReady({ timeoutSeconds: Math.max(1, Math.min(CONNECT_TIMEOUT_SECONDS, Math.ceil((deadlineAt - Date.now()) / 1000))), contextId, preferredContextId });
  for (let attempt = 1; attempt <= TRANSPORT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && Date.now() >= deadlineAt) throw new BrowserCommandError('Browser command deadline exhausted across transport retries.', RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT);
    const remainingMs = Math.max(1000, deadlineAt - Date.now());
    const command = { id, action, ...params, timeout: timeoutSeconds, deadlineAt };
    try {
      const res = await requestDaemon('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), timeout: remainingMs + HTTP_MARGIN_MS });
      const result = await res.json();
      if (result.ok) return result;
      if (result.errorCode && UNKNOWN_OUTCOME_CODES.has(result.errorCode)) throw new BrowserCommandError(result.error ?? 'Browser command result is unknown', result.errorCode, result.errorHint);
      if ((PRE_DISPATCH_CODES.has(result.errorCode) || result.errorCode === 'daemon_shutting_down') && !ensured) {
        ensured = true;
        await ensure();
        continue;
      }
      if (classifyBrowserError(new BrowserCommandError(result.error ?? '', result.errorCode)).kind === 'extension-transient' && !semanticRetried) {
        semanticRetried = true;
        id = nextId();
        await sleep(1500);
        continue;
      }
      throw new BrowserCommandError(result.error ?? 'Daemon command failed', result.errorCode, result.errorHint);
    } catch (error) {
      if (error instanceof BrowserCommandError || error instanceof BrowserConnectError) throw error;
      if (error?.name === 'AbortError') throw new BrowserCommandError('Browser command timed out client-side; the page may still have applied it.', RESULT_UNKNOWN_CODE, RESULT_UNKNOWN_HINT);
      if (error instanceof TypeError) {
        // The daemon is down or restarting. The LuzCrawl extension journals command ids, so resending is safe.
        await ensure();
        continue;
      }
      throw error;
    }
  }
  throw new BrowserCommandError('Browser command: max attempts exhausted', 'max_attempts_exhausted');
}

export async function sendCommand(action, params = {}) {
  return (await sendCommandRaw(action, params)).data;
}

export async function sendCommandFull(action, params = {}) {
  const result = await sendCommandRaw(action, params);
  return { data: result.data, page: result.page };
}

// page.evaluate accepts a function plus JSON arguments, or a string expression/function source.
export function buildEvaluateExpression(input, args = []) {
  if (typeof input === 'function') {
    const source = input.toString().trim();
    const isFunction = /^(async\s+)?function[\s(]/.test(source) || /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source);
    if (!isFunction || source.includes('[native code]')) throw new Error('page.evaluate(fn) requires a serializable arrow/function expression');
    const serialized = JSON.stringify(args);
    if (serialized === undefined) throw new Error('page.evaluate arguments must be JSON-serializable');
    return `(${source})(...${serialized})`;
  }
  if (args.length > 0) throw new Error('page.evaluate string input does not accept args; use page.evaluate(fn, ...args) instead');
  if (typeof input !== 'string') return 'undefined';
  const code = input.trim();
  if (!code) return 'undefined';
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code) || /^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;
  return code;
}

const isStalePageError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('stale page identity') || /^Page not found:\s*\S+\s*$/.test(message);
};

// One automation session in one browser profile. After navigate, the page identity (targetId) is remembered and sent
// with every page-scoped command.
export class Page {
  constructor({ session, contextId, preferredContextId, windowMode, surface = 'browser', idleTimeout, siteSession } = {}) {
    this.session = session;
    this.contextId = contextId;
    this.preferredContextId = preferredContextId;
    this.windowMode = windowMode;
    this.surface = surface;
    this.siteSession = siteSession;
    this._idleTimeout = idleTimeout;
    this._page = undefined;
    this._networkCaptureUnsupported = false;
  }

  _sessionOpts() {
    return {
      session: this.session,
      surface: this.surface,
      ...(this.contextId && { contextId: this.contextId }),
      ...(this.preferredContextId && { preferredContextId: this.preferredContextId }),
      ...(this._idleTimeout != null && { idleTimeout: this._idleTimeout }),
      ...(this.windowMode && { windowMode: this.windowMode }),
      ...(this.siteSession && { siteSession: this.siteSession }),
    };
  }

  _cmdOpts() {
    return { ...this._sessionOpts(), ...(this._page !== undefined && { page: this._page }) };
  }

  getActivePage() {
    return this._page;
  }

  setActivePage(page) {
    this._page = page;
  }

  async goto(url, options = {}) {
    let result;
    try {
      result = await sendCommandFull('navigate', { url, ...this._cmdOpts() });
    } catch (error) {
      if (!isStalePageError(error) || this._page === undefined) throw error;
      this._page = undefined;
      result = await sendCommandFull('navigate', { url, ...this._cmdOpts() });
    }
    if (result.page) this._page = result.page;
    // Hide automation fingerprints and let the DOM settle in one round trip.
    if (options.waitUntil === 'none') {
      await sendCommand('exec', { code: generateStealthJs(), ...this._cmdOpts() }).catch(() => {});
      return;
    }
    const maxMs = options.settleMs ?? 1000;
    const settle = { code: `${generateStealthJs()};\n${waitForDomStableJs(maxMs, Math.min(500, maxMs))}`, ...this._cmdOpts() };
    try {
      await sendCommand('exec', settle);
    } catch (error) {
      const advice = classifyBrowserError(error);
      if (advice.kind !== 'target-navigation') throw error;
      await sleep(advice.delayMs);
      await sendCommand('exec', settle).catch((retryError) => {
        if (classifyBrowserError(retryError).kind !== 'target-navigation') throw retryError;
      });
    }
  }

  async evaluate(input, ...args) {
    const code = buildEvaluateExpression(input, args);
    try {
      return await sendCommand('exec', { code, ...this._cmdOpts() });
    } catch (error) {
      const advice = classifyBrowserError(error);
      if (advice.kind !== 'target-navigation') throw error;
      await sleep(advice.delayMs);
      return sendCommand('exec', { code, ...this._cmdOpts() });
    }
  }

  async tabs() {
    const result = await sendCommand('tabs', { op: 'list', ...this._sessionOpts() });
    return Array.isArray(result) ? result : [];
  }

  async newTab(url) {
    const result = await sendCommandFull('tabs', { op: 'new', ...(url !== undefined && { url }), ...this._sessionOpts() });
    return result.page;
  }

  async selectTab(target) {
    const result = await sendCommandFull('tabs', { op: 'select', ...(typeof target === 'number' ? { index: target } : { page: target }), ...this._sessionOpts() });
    if (result.page) this._page = result.page;
  }

  async closeTab(target) {
    const params = { op: 'close', ...this._sessionOpts() };
    if (typeof target === 'number') params.index = target;
    else if (typeof target === 'string') params.page = target;
    else if (this._page !== undefined) params.page = this._page;
    const result = await sendCommand('tabs', params);
    const closed = typeof result?.closed === 'string' ? result.closed : undefined;
    if ((closed && closed === this._page) || (!closed && (target === undefined || target === this._page))) this._page = undefined;
  }

  async closeWindow() {
    try {
      await sendCommand('close-window', this._sessionOpts());
    } catch {
      // The window may already be closed.
    } finally {
      this._page = undefined;
    }
  }

  async screenshot(options = {}) {
    return sendCommand('screenshot', { ...this._cmdOpts(), format: options.format, quality: options.quality, fullPage: options.fullPage, width: options.width, height: options.height });
  }

  async startNetworkCapture(pattern = '') {
    if (this._networkCaptureUnsupported) return false;
    try {
      await sendCommand('network-capture-start', { pattern, ...this._cmdOpts() });
      return true;
    } catch (error) {
      if (!/unknown action.*network-capture|network capture.*not supported/i.test(error?.message ?? '')) throw error;
      this._networkCaptureUnsupported = true;
      return false;
    }
  }

  async readNetworkCapture() {
    if (this._networkCaptureUnsupported) return [];
    try {
      const result = await sendCommand('network-capture-read', this._cmdOpts());
      return Array.isArray(result) ? result : [];
    } catch (error) {
      if (!/unknown action.*network-capture|network capture.*not supported/i.test(error?.message ?? '')) throw error;
      this._networkCaptureUnsupported = true;
      return [];
    }
  }

  async waitForDownload(pattern = '', timeoutMs = 30000) {
    return sendCommand('wait-download', { pattern, timeoutMs, ...this._cmdOpts() });
  }
}

// connect() waits for the daemon and the selected profile's extension, then returns a Page for the session.
export class BrowserBridge {
  constructor() {
    this.page = null;
  }

  async connect({ session, contextId, preferredContextId, windowMode, surface, idleTimeout, siteSession, timeout } = {}) {
    if (this.page) return this.page;
    if (!session?.trim()) throw new Error('Browser session is required');
    await ensureBridgeReady({ timeoutSeconds: timeout ?? CONNECT_TIMEOUT_SECONDS, contextId, preferredContextId });
    this.page = new Page({ session: session.trim(), contextId, preferredContextId, windowMode, surface, idleTimeout, siteSession });
    return this.page;
  }

  async close() {
    this.page = null;
  }
}
