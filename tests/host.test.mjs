import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.LUZ_CRAWL_STATE ??= path.join(os.tmpdir(), `luz-host-test-${process.pid}`);
const { parseCommandLine } = await import('../lib/host.mjs');

test('the command host parses the argument arrays the CLI entry builds', () => {
  const { spec, options } = parseCommandLine(['--profile', 'edge-a', 'luz-crawl', 'capture', 'https://example.com/a', '--out', 'D:/out', '--scrolls', '12', '-f', 'json', '--download', '--window', 'background']);
  assert.equal(spec.name, 'capture');
  assert.equal(options.url, 'https://example.com/a');
  assert.equal(options.scrolls, 12);
  assert.equal(options.download, true);
  assert.equal(options.comments, false);
  assert.equal(options.headless, true);
  assert.equal(options.__optionSources.out, 'cli');
  assert.equal(options.__optionSources.headless, 'default');
  const search = parseCommandLine(['luz-crawl', 'search', 'web', 'a b', '--read', '2', '--site', 'example.com']).options;
  assert.deepEqual([search.platform, search.query, search.read, search.site], ['web', 'a b', 2, 'example.com']);
  const batch = parseCommandLine(['luz-crawl', 'batch', '--file', 'jobs.json', '--allow-write', '--concurrency', '6']).options;
  assert.equal(batch['allow-write'], true);
  assert.equal(batch.concurrency, 6);
  assert.equal(parseCommandLine(['luz-crawl', 'capture', 'u', '--no-headless']).options.headless, false);
});

test('the command host rejects unknown commands, unknown options and missing arguments', () => {
  assert.throws(() => parseCommandLine(['luz-crawl', 'frobnicate']), /Unknown LuzCrawl command/);
  assert.throws(() => parseCommandLine(['luz-crawl', 'capture']), /Missing url/);
  assert.throws(() => parseCommandLine(['luz-crawl', 'capture', 'u', '--bogus']), /Unknown option/);
  assert.throws(() => parseCommandLine(['luz-crawl', 'capture', 'u', '--scrolls', 'many']), /integer/);
  assert.throws(() => parseCommandLine(['luz-crawl', 'batch']), /file is required/);
});
