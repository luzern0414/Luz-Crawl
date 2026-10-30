// Launches Microsoft Edge with the bundled LuzCrawl extension on its own user-data directory, without Playwright.
// A DevTools pipe (fds 3/4) is used only to identify the extension's bridge profile, refresh its service worker and
// close the browser cleanly; all page work goes through the extension and the bridge daemon.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const EDGE_EXECUTABLE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CONTEXT_KEY = 'opencli_context_id_v1';

// Edge reports a reduced user agent (major.0.0.0); headless mode would otherwise announce HeadlessChrome.
export function edgeUserAgent(executable = EDGE_EXECUTABLE) {
  const versions = existsSync(path.dirname(executable)) ? readdirSync(path.dirname(executable)).filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)) : [];
  const major = versions.map((name) => Number(name.split('.')[0])).sort((a, b) => b - a)[0];
  if (!major) return undefined;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`;
}

export function browserProxy(env = process.env) {
  const value = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new Error('Unsupported browser proxy protocol.');
  if (url.username) throw new Error('A proxy with a user name and password is not supported for the silent browser; use a local proxy without authentication.');
  return { server: `${url.protocol}//${url.host}`, bypass: 'localhost;127.0.0.1;[::1]' };
}

// Downloads (the cookie fallback) land in a managed folder without prompting.
async function writeDownloadPreferences(userDataDir, downloadsDir) {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs = {};
  try {
    prefs = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (prefs.download?.default_directory === downloadsDir && prefs.download?.prompt_for_download === false) return;
  prefs.download = { ...prefs.download, default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(prefs));
}

class PipeConnection {
  constructor(input, output) {
    this.input = input;
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Map();
    this.closed = false;
    let pending = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\0')) >= 0) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (message.id === undefined) {
          for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
          continue;
        }
        const waiter = this.waiting.get(message.id);
        if (!waiter) continue;
        this.waiting.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      }
    });
    const fail = () => {
      this.closed = true;
      for (const waiter of this.waiting.values()) waiter.reject(new Error('Browser closed.'));
      this.waiting.clear();
    };
    output.on('close', fail);
    output.on('error', fail);
    input.on('error', () => {});
  }

  // DevTools events (messages without an id), e.g. Fetch.requestPaused; the listener receives (params, sessionId).
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Browser closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A running Edge holds <user-data-dir>/lockfile open exclusively; a second Edge on the same folder silently hands
// its command line to the first and exits, so check before launching.
async function profileInUse(userDataDir) {
  try {
    const handle = await fs.open(path.join(userDataDir, 'lockfile'), 'r+');
    await handle.close();
    return false;
  } catch (error) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
  }
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
      resolve();
    }
  });
}

// Resolves once the browser answers on the DevTools pipe. Rejects with a "profile in use" error when another Edge
// already owns userDataDir, so callers can move on to the next profile slot.
export async function launchEdge({ userDataDir, extension, headless = true, startUrl = 'about:blank', executable = EDGE_EXECUTABLE, downloadsDir, userAgent = edgeUserAgent(executable), proxy = browserProxy(), windowSize = [1220, 720] }) {
  if (!existsSync(executable)) throw new Error(`Microsoft Edge was not found at ${executable}.`);
  await fs.mkdir(userDataDir, { recursive: true });
  if (await profileInUse(userDataDir)) throw new Error(`Browser profile is in use: ${userDataDir}`);
  if (downloadsDir) await fs.mkdir(downloadsDir, { recursive: true });
  if (downloadsDir) await writeDownloadPreferences(userDataDir, downloadsDir);
  const args = [
    `--user-data-dir=${userDataDir}`,
    // The extension is installed over the DevTools pipe (Extensions.loadUnpacked), which needs this switch.
    ...(extension ? ['--enable-unsafe-extension-debugging'] : []),
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-crash-restore-bubble',
    `--window-size=${windowSize.join(',')}`,
    ...(headless ? ['--headless=new'] : []),
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ...(proxy ? [`--proxy-server=${proxy.server}`, `--proxy-bypass-list=${proxy.bypass}`] : []),
    startUrl,
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const cdp = new PipeConnection(child.stdio[3], child.stdio[4]);
  const started = await Promise.race([
    cdp.send('Browser.getVersion').then(() => true),
    exited.then(() => false),
    sleep(30000).then(() => false),
  ]).catch(() => false);
  if (!started) {
    await killTree(child.pid);
    const busy = /singleton|in use|lock/i.test(stderr) || await profileInUse(userDataDir);
    throw new Error(busy ? `Browser profile is in use: ${userDataDir}` : `Microsoft Edge did not start (${stderr.trim().split('\n').at(-1) || 'no output'}).`);
  }
  // Install (or refresh from disk) the unpacked extension. Unlike --load-extension, this keeps it enabled when the
  // profile is reused. The id derives from the path string, so callers pass the same path every time.
  let extensionId;
  if (extension) {
    try {
      ({ id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: extension }));
    } catch (error) {
      await killTree(child.pid);
      throw new Error(`Edge could not load the LuzCrawl extension (${error.message}).`);
    }
  }

  // A Manifest V3 service worker only starts on an event; if it is not running yet, open the extension's popup page
  // once — it messages the worker, which wakes it up.
  let woken = false;
  const extensionWorker = async (timeoutMs = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const worker = targetInfos.find((target) => target.type === 'service_worker' && (extensionId ? target.url === `chrome-extension://${extensionId}/dist/background.js` : /^chrome-extension:\/\/[a-p]{32}\/dist\/background\.js$/.test(target.url)));
      if (worker) return worker;
      if (!woken && extensionId && Date.now() - started > 1500) {
        woken = true;
        const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html`, background: true }).catch(() => ({}));
        if (targetId) setTimeout(() => cdp.send('Target.closeTarget', { targetId }).catch(() => {}), 3000);
      }
      await sleep(250);
    }
    throw new Error('The LuzCrawl extension did not start in the browser.');
  };
  const evaluateInWorker = async (expression) => {
    const worker = await extensionWorker();
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    try {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  };

  return {
    pid: child.pid,
    exited,
    extensionId,
    // Raw DevTools access, used by tests that drive a page directly.
    cdp,
    // The bridge profile id the extension generated for this user-data directory (stored in its local storage).
    async contextId(timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluateInWorker(`chrome.storage.local.get(${JSON.stringify(CONTEXT_KEY)}).then((items) => items[${JSON.stringify(CONTEXT_KEY)}] ?? null)`).catch(() => null);
        if (typeof value === 'string' && value) return value;
        await sleep(300);
      }
      throw new Error('The LuzCrawl extension did not report its browser profile id.');
    },
    // A persistent profile can keep running an older copy of the unpacked extension; reload it from disk.
    async reloadExtension() {
      const before = (await extensionWorker()).targetId;
      await evaluateInWorker('chrome.runtime.reload()').catch(() => {});
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(300);
        const worker = await extensionWorker(1000).catch(() => null);
        if (worker && worker.targetId !== before) return;
      }
    },
    async close() {
      if (child.exitCode !== null) return;
      await cdp.send('Browser.close').catch(() => {});
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!done) await killTree(child.pid);
    },
  };
}
