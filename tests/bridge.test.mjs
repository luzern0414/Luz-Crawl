import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LUZ_BRIDGE_PORT = String(19900 + Math.floor(Math.random() * 90));
const { startDaemon } = await import('../lib/bridge/daemon.mjs');
const { BrowserBridge, sendCommand, fetchDaemonStatus, BrowserCommandError } = await import('../lib/bridge/client.mjs');
const port = Number(process.env.LUZ_BRIDGE_PORT);
let daemon;
before(async () => {
  daemon = startDaemon({ port, onExit: () => {} });
  await daemon.ready;
});
after(() => daemon.shutdown());

// A stand-in for the browser extension: says hello, then answers each command.
async function fakeExtension(contextId, answer) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = async (event) => {
    const command = JSON.parse(event.data);
    ws.send(JSON.stringify(await answer(command)));
  };
  ws.send(JSON.stringify({ type: 'hello', contextId, version: '2.7.0', compatRange: '>=1.7.0' }));
  for (let i = 0; i < 50; i++) {
    const status = await fetchDaemonStatus({ contextId });
    if (status?.extensionConnected) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return ws;
}

test('the daemon relays commands to the selected profile, keeps page identity and carries large messages', async (t) => {
  const seen = [];
  const big = 'x'.repeat(6 * 1024 * 1024);
  const ext = await fakeExtension('edge-a', (command) => {
    seen.push(command);
    if (command.action === 'navigate') return { id: command.id, ok: true, data: { url: command.url }, page: 'TARGET-1' };
    if (command.action === 'exec' && command.code === 'big') return { id: command.id, ok: true, data: big };
    if (command.action === 'exec') return { id: command.id, ok: true, data: { page: command.page ?? null } };
    return { id: command.id, ok: false, error: `Unknown action: ${command.action}` };
  });
  t.after(() => ext.close());

  const status = await fetchDaemonStatus();
  assert.equal(status.service, 'luz-crawl');
  assert.deepEqual(status.profiles.map((profile) => profile.contextId), ['edge-a']);

  const page = await new BrowserBridge().connect({ session: 'luzcrawl-test', contextId: 'edge-a', windowMode: 'background' });
  await page.goto('https://example.com/', { waitUntil: 'none' });
  assert.equal(page.getActivePage(), 'TARGET-1');
  assert.deepEqual(await page.evaluate('1 + 1'), { page: 'TARGET-1' });
  assert.equal(seen.at(-1).session, 'luzcrawl-test');
  assert.equal(seen.at(-1).windowMode, 'background');
  assert.equal((await sendCommand('exec', { contextId: 'edge-a', code: 'big' })).length, big.length);
  await assert.rejects(sendCommand('frobnicate', { contextId: 'edge-a' }), (error) => error instanceof BrowserCommandError && /Unknown action/.test(error.message));
});

test('an unknown profile fails fast and multiple profiles require a choice', async (t) => {
  const answer = (command) => ({ id: command.id, ok: true, data: 'ok' });
  const a = await fakeExtension('edge-a', answer);
  const b = await fakeExtension('edge-b', answer);
  t.after(() => { a.close(); b.close(); });
  assert.equal(await sendCommand('exec', { contextId: 'edge-b', code: '1' }), 'ok');
  const status = await fetchDaemonStatus();
  assert.equal(status.profileRequired, true);
  await assert.rejects(new BrowserBridge().connect({ session: 's', contextId: 'missing', timeout: 1 }), /is not connected/);
  await assert.rejects(new BrowserBridge().connect({ session: 's', timeout: 1 }), /Multiple Browser Bridge profiles/);
});

test('the daemon refuses web-page origins and requests without the LuzCrawl header', async (t) => {
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/status`)).status, 403);
  assert.equal((await fetch(`${base}/status`, { headers: { 'x-luzcrawl': '1', origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/ping`)).status, 200);
});
