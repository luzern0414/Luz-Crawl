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

test('the extension asks only for permissions its code uses and cannot hand out cookie values', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));
  const background = await fs.readFile(new URL('../browser-extension/dist/background.js', import.meta.url), 'utf8');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'debugger', 'declarativeNetRequestWithHostAccess', 'downloads', 'downloads.ui', 'storage', 'tabGroups', 'tabs']);
  // Every named permission has a matching chrome.* call; a permission without one is attack surface without a use.
  for (const api of ['debugger', 'alarms', 'storage', 'tabGroups', 'downloads', 'declarativeNetRequest', 'tabs']) assert.match(background, new RegExp(`chrome\\.${api}\\b`), api);
  assert.doesNotMatch(background, /chrome\.cookies|handleCookies/);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.doesNotMatch(background, /\beval\s*\(|new Function\s*\(|importScripts\s*\(\s*['"]https?:/);
});

test('the shared report stylesheet and icon are the ones the Python preflight page uses', async () => {
  const { FORMAL_CSS, FORMAL_ICON, FORMAL_CSP, scopedFormalCSS } = await import('../lib/formal-html.mjs');
  const python = await fs.readFile(new URL('../scripts/crawl_preflight.py', import.meta.url), 'utf8');
  assert.ok(python.includes(FORMAL_ICON));
  assert.ok(python.includes(FORMAL_CSP));
  assert.match(FORMAL_CSS, /body\{[^}]*font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif/);
  assert.match(FORMAL_CSS, /\/\* luz-md-type:start[\s\S]*\/\* luz-md-type:end \*\//);
  // Every size on the page comes from the Markdown type block; the sheet outside it names none of its own.
  const rest = FORMAL_CSS.replace(/\/\* luz-md-type:start[\s\S]*\/\* luz-md-type:end \*\//, '');
  assert.doesNotMatch(rest, /font-size|font:|line-height/);
  assert.match(FORMAL_CSS, /body \{ font-size: var\(--md-body\)/);
  assert.match(FORMAL_CSS, /overflow-wrap:anywhere/);
  // The scoped copy appended to a saved page keeps the type tokens on the report container and carries no comment inside a selector.
  const scoped = scopedFormalCSS('.luz-report');
  assert.doesNotMatch(scoped, /\/\*|\*\//);
  assert.match(scoped, /\.luz-report\{\s*--md-body: 16px;/);
  assert.match(scoped, /@media \(min-width: 768px\)\{\.luz-report\{\s*--md-body: 18px;/);
  assert.match(scoped, /\.luz-report h1\{\s*margin: 0 0 24px; font-size: var\(--md-h1\)/);
  assert.match(scoped, /\.luz-report\{margin:0;background:#fff;color:var\(--ink\);font-family:/);
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
