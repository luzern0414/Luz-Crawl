// Minimal page driver over Edge's DevTools pipe for DOM tests: a fresh headless Edge without the extension, with
// newPage / setContent / goto / evaluate / route / url. Tests skip when Edge is not installed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { EDGE_EXECUTABLE, launchEdge } from '../lib/edge.mjs';

export const edgeAvailable = existsSync(EDGE_EXECUTABLE);

export async function openTestBrowser() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'luz-dom-test-'));
  const edge = await launchEdge({ userDataDir, headless: true, proxy: undefined });
  const { cdp } = edge;
  const routes = new Map();
  cdp.on('Fetch.requestPaused', async ({ requestId, request }, sessionId) => {
    const handler = [...routes.entries()].find(([pattern]) => request.url.startsWith(pattern.replace(/\*+$/, '')))?.[1];
    if (!handler) return cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    handler({
      fulfill: ({ status = 200, contentType = 'text/html', body = '' }) => cdp.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: contentType }], body: Buffer.from(body).toString('base64') }, sessionId),
    });
  });
  const loaded = new Map();
  cdp.on('Page.loadEventFired', (_, sessionId) => {
    const waiters = loaded.get(sessionId) ?? [];
    loaded.set(sessionId, []);
    for (const resolve of waiters) resolve();
  });
  const waitForLoad = (sessionId) => new Promise((resolve) => {
    loaded.set(sessionId, [...(loaded.get(sessionId) ?? []), resolve]);
    setTimeout(resolve, 10000);
  });

  const used = new Set();
  async function newPage() {
    // The first page reuses the blank tab Edge starts with, so page counts match a fresh browser context.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const blank = targetInfos.find((target) => target.type === 'page' && !used.has(target.targetId));
    const { targetId } = blank ?? await cdp.send('Target.createTarget', { url: 'about:blank' });
    used.add(targetId);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const evaluate = async (fn, ...args) => {
      const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn;
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    return {
      evaluate,
      async goto(url) {
        const load = waitForLoad(sessionId);
        await cdp.send('Page.navigate', { url }, sessionId);
        await load;
      },
      async setContent(html) {
        await evaluate((markup) => {
          document.open();
          document.write(markup);
          document.close();
        }, html);
      },
      async route(pattern, handler) {
        routes.set(pattern, handler);
        await cdp.send('Fetch.enable', { patterns: [...routes.keys()].map((urlPattern) => ({ urlPattern })) }, sessionId);
      },
      url: () => evaluate('location.href'),
    };
  }

  return {
    newPage,
    async pageCount() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.filter((target) => target.type === 'page').length;
    },
    async close() {
      await edge.close();
      // Edge's child processes can hold files for a moment after it exits.
      await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    },
  };
}
