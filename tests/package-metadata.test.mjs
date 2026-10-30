import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sourceURL } from '../lib/platforms.mjs';

test('extension display version matches the Skill release and the package has no dependencies', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[field], undefined, field);
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.version_name.startsWith(`LuzCrawl ${pkg.version} (`));
});

test('the referenced website library ships distinct public entries with separate acceptance states', async () => {
  const text = await fs.readFile(new URL('../references/site-library.json', import.meta.url), 'utf8');
  const library = JSON.parse(text);
  assert.equal(library.schema_version, 1); assert(library.sites.length > 0);
  const ids = new Set();
  for (const site of library.sites) {
    assert.equal(typeof site.id, 'string'); assert(site.id && !ids.has(site.id)); ids.add(site.id);
    assert(site.name && site.kind); assert.equal(sourceURL(site.url), site.url);
    if (site.probe) assert(site.probe.status);
    for (const dimension of ['page', 'search', 'detail', 'statistics', 'media']) assert(library.verification_states.includes(site.verification[dimension]), `${site.id}.${dimension}`);
  }
  for (const id of ['gdggzy', 'qianlima', 'yfb', 'huitun', 'pinterest']) assert(ids.has(id));
  assert(!/\b[a-z]:[\\/]|12860|raw\/00|access_token|xsec_token|cookie=/i.test(text));
});
