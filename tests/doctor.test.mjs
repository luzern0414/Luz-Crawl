import test from 'node:test';
import assert from 'node:assert/strict';
import { silentReadiness } from '../lib/doctor.mjs';

const base = { nodeOk: true, edgeInstalled: true, daemon: { port: 1 }, extensionFiles: true };

test('the silent Edge counts as ready without a connected visible browser, and says what is missing otherwise', () => {
  assert.deepEqual(silentReadiness(base), { silent_ready: true, silent_missing: [] });
  assert.deepEqual(silentReadiness({ ...base, nodeOk: false }), { silent_ready: false, silent_missing: ['node_unsupported'] });
  assert.deepEqual(silentReadiness({ ...base, edgeInstalled: false, daemon: null }), { silent_ready: false, silent_missing: ['edge_missing', 'daemon_stopped'] });
  assert.deepEqual(silentReadiness({ ...base, extensionFiles: false }), { silent_ready: false, silent_missing: ['extension_files_missing'] });
});
