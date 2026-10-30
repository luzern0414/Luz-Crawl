import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { preferences } from './memory.mjs';
import { ensureBridgeReady, fetchDaemonStatus } from './bridge/client.mjs';
import { BRIDGE_PORT, BRIDGE_VERSION } from './bridge/constants.mjs';
import { EDGE_EXECUTABLE, edgeUserAgent } from './edge.mjs';
import { VERSION } from './version.mjs';

export function profileFromArgs(fallback) {
  if (Object.hasOwn(process.env, 'LUZ_VISIBLE_FALLBACK_PROFILE')) return process.env.LUZ_VISIBLE_FALLBACK_PROFILE || undefined;
  const index = process.argv.indexOf('--profile');
  return (index >= 0 ? process.argv[index + 1] : process.argv.find((value) => value.startsWith('--profile='))?.slice(10)) || fallback;
}

export const BUNDLED_EXTENSION = fileURLToPath(new URL('../browser-extension/', import.meta.url));

async function scanExtensions() {
  const local = process.env.LOCALAPPDATA;
  const bases = process.platform === 'win32' && local ? [path.join(local, 'Microsoft', 'Edge', 'User Data'), path.join(local, 'Google', 'Chrome', 'User Data')] : [path.join(os.homedir(), '.config', 'google-chrome'), path.join(os.homedir(), '.config', 'microsoft-edge'), path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')];
  const records = [];
  for (const base of bases) {
    for (const profile of await fs.readdir(base).catch(() => [])) {
      if (!/^(Default|Profile \d+)$/.test(profile)) continue;
      for (const filename of ['Preferences', 'Secure Preferences']) {
        let settings;
        try { settings = JSON.parse(await fs.readFile(path.join(base, profile, filename), 'utf8')).extensions?.settings || {}; } catch { continue; }
        for (const [id, value] of Object.entries(settings)) {
          if (!/opencli|browser bridge|luz-?crawl/i.test(`${value.path || ''} ${value.manifest?.name || ''}`)) continue;
          const extensionPath = value.path && (path.isAbsolute(value.path) ? value.path : path.join(base, profile, 'Extensions', value.path));
          let manifest;
          try { manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8')); } catch {}
          records.push({ browser_data: base, profile, id, path: extensionPath, version: manifest?.version, name: manifest?.name, disabled: value.state === 0 || Boolean(value.disable_reasons?.length), disable_reasons: value.disable_reasons || [], source: filename });
        }
      }
    }
  }
  return records;
}

// Everything LuzCrawl needs ships in this folder: Node runs scripts/luz-crawl.mjs, lib/bridge/daemon.mjs relays to the
// browser-extension/ loaded in Edge. Doctor starts the bridge daemon when it is not running, so an extension that is
// already loaded connects within a few seconds.
export async function doctor(options = {}) {
  const browserPreferences = await preferences();
  const configuredProfile = browserPreferences.reuse_browser_profile === false ? undefined : browserPreferences.browser_profile;
  const profile = profileFromArgs(options.profile || configuredProfile);
  const routing = profile ? { contextId: profile } : {};
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor > 24 || (nodeMajor === 24 && Number(process.versions.node.split('.')[1]) >= 5);
  const edgeInstalled = existsSync(EDGE_EXECUTABLE);
  await ensureBridgeReady({ timeoutSeconds: options.wait ?? 5, ...routing }).catch(() => {});
  const daemon = await fetchDaemonStatus(routing);
  const extensions = await scanExtensions();
  const state = !nodeOk ? 'node_unsupported'
    : !daemon ? 'daemon_stopped'
      : daemon.profileRequired ? 'profile_selection_required'
        : daemon.profileDisconnected ? 'profile_disconnected'
          : daemon.extensionConnected ? 'ready'
            : 'extension_disconnected';
  const hints = {
    node_unsupported: `Node.js 24.5 or newer is required (found ${process.versions.node}).`,
    daemon_stopped: `The LuzCrawl bridge could not start on 127.0.0.1:${BRIDGE_PORT}. Check that the port is free, then repeat doctor.`,
    profile_selection_required: 'Several browser profiles are connected; pass --profile with the intended context_id from daemon.profiles.',
    profile_disconnected: 'The selected browser profile is offline. Open that profile or choose a connected profile with --profile.',
    extension_disconnected: 'Open Edge with this skill\'s browser-extension/ loaded (edge://extensions, Developer mode, Load unpacked), or reload it there after an update, then repeat doctor. The silent browser still works without it.',
    ready: 'The LuzCrawl extension is connected. Platform login/content still requires an actual page capture.',
  };
  const selectedProfile = daemon?.profiles?.find((item) => item.contextId === profile || item.contextId === daemon.contextId);
  return {
    schema_version: 3,
    state,
    ready: state === 'ready',
    checked_at: new Date().toISOString(),
    runtime: { skill_version: VERSION, node: process.versions.node, node_supported: nodeOk, external_dependencies: [] },
    edge: { path: EDGE_EXECUTABLE, installed: edgeInstalled, user_agent: edgeInstalled ? edgeUserAgent() ?? null : null },
    daemon: daemon ? { port: daemon.port, version: daemon.daemonVersion, current: daemon.daemonVersion === BRIDGE_VERSION, context_id: daemon.contextId, extension_connected: daemon.extensionConnected, profiles: daemon.profiles, pending: daemon.pending } : null,
    browser_preferences: {
      preferred_browser: browserPreferences.browser,
      reuse_browser_profile: browserPreferences.reuse_browser_profile !== false,
      saved_profile: browserPreferences.browser_profile || null,
      selected_profile: profile || null,
      observed_browser: selectedProfile?.browser || selectedProfile?.browserType || null,
      site_login_checked: false,
    },
    extensions,
    hint: hints[state],
    extension_install: {
      bundled_path: BUNDLED_EXTENSION,
      bundled_loaded: extensions.some((extension) => !extension.disabled && extension.name === 'LuzCrawl' && extension.path && path.resolve(extension.path) === path.resolve(BUNDLED_EXTENSION)),
      bridge_port: BRIDGE_PORT,
      manual_step: 'Enable Developer mode, Load unpacked and select this skill browser-extension directory; after updating the skill, press Reload on the LuzCrawl card.',
    },
  };
}
