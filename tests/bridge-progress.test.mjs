import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LUZ_BRIDGE_PORT = String(20000 + Math.floor(Math.random() * 80));
const { startDaemon } = await import('../lib/bridge/daemon.mjs');
const { fetchDaemonStatus, updateDaemonProgress } = await import('../lib/bridge/client.mjs');
const port = Number(process.env.LUZ_BRIDGE_PORT);
let daemon;

before(async () => {
  daemon = startDaemon({ port, onExit: () => {} });
  await daemon.ready;
});
after(() => daemon.shutdown());

test('daemon exposes bounded task progress to the connected extension status', async () => {
  const statusBefore = await fetchDaemonStatus();
  assert.equal(statusBefore.task, undefined);
  const result = await updateDaemonProgress({
    contextId: 'edge-progress',
    session: 'luzcrawl-test',
    active: true,
    access_mode: 'authorized_browser',
    stage: 'comments',
    query_count: 3,
    candidate_count: 14,
    verified_count: 5,
    comment_loaded: 23,
  });
  assert.equal(result?.ok, true);
  const status = await fetchDaemonStatus({ contextId: 'edge-progress' });
  assert.equal(status.task.access_mode, 'authorized_browser');
  assert.equal(status.task.query_count, 3);
  assert.equal(status.task.comment_loaded, 23);
  assert.equal(status.task.active, true);
});
