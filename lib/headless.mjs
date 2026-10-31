import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWrite, stateRoot } from './archive.mjs';
import { BUNDLED_EXTENSION } from './doctor.mjs';
import { ensureBridgeReady, fetchDaemonStatus } from './bridge/client.mjs';
import { EDGE_EXECUTABLE, launchEdge } from './edge.mjs';
import { pendingTasks, preferences } from './memory.mjs';
import { cancelTask, parkTask } from './browser-session.mjs';
import { captureQuality } from './extract-page.mjs';


export function visibleFallbackReason(result) {
  const reason = result?.awaiting_reason || result?.stop_reason || result?.failure?.code;
  if (result?.cooldown_evidence?.source === 'platform_page') return 'visible_platform_cooldown';
  if (['rate_limited', 'operation_budget', 'cancelled'].includes(reason)) return null;
  if (result?.status === 'awaiting_user') return ['login_required', 'verification_required'].includes(reason) ? `visible_${reason}` : null;
  // A partial read whose content (or every opened source / every found candidate) is already verified needs no visible retry.
  if (result?.status === 'partial' && (
    result?.url_check?.valid_content === true
    || (Array.isArray(result?.sources) && result.sources.length > 0 && result.sources.every(x => x?.url_check?.valid_content === true))
    || (Array.isArray(result?.candidates) && result.candidates.length > 0 && !(result.sources || []).some(x => x?.url_check?.valid_content === false))
  )) return null;
  if (['partial', 'blocked'].includes(result?.status)) return `visible_${reason || result.status}`;
  if (result?.status === 'failed' && ['login_required', 'verification_required', 'access_denied', 'unavailable', 'transient_failure'].includes(reason)) return `visible_${reason}`;
  if (result?.url_check?.valid_content === false) return 'visible_content_unverified';
  return null;
}

async function persistVisibleFallback(result, options) {
  if (!result.task_id || !options.out) return;
  const file = path.join(options.out, 'raw/tasks', `${result.task_id}.json`);
  try {
    const task = JSON.parse(await fs.readFile(file, 'utf8'));
    await atomicWrite(file, { ...task, result: { ...task.result, visible_fallback: result.visible_fallback, ...(result.headless_fallback ? { headless_fallback: result.headless_fallback } : {}) } });
  } catch (error) {
    result.visible_fallback = { ...result.visible_fallback, persistence_error: error.message };
  }
}

// Picks the most recently seen connected visible browser that is not a silent (headless) session.
// On Windows, with none connected, opens Edge and waits up to 25 s for its extension (LUZ_NO_BROWSER_LAUNCH=1 disables this).
export async function pickVisibleProfile(exclude) {
  const silent = await fs.readdir(path.join(stateRoot(), 'headless-contexts')).catch(() => []);
  await ensureBridgeReady({ timeoutSeconds: 1 }).catch(() => {});
  const find = async () => {
    try {
      const status = await fetchDaemonStatus();
      return (status?.profiles || [])
        .filter(item => item.extensionConnected && item.contextId !== exclude && !silent.includes(item.contextId))
        .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))[0]?.contextId;
    } catch {
      return undefined;
    }
  };
  let found = await find();
  if (found || process.platform !== 'win32' || process.env.LUZ_NO_BROWSER_LAUNCH === '1') return found;
  if (!existsSync(EDGE_EXECUTABLE)) return undefined;
  console.error('[LuzCrawl] 没有已连接的可见浏览器，正在打开 Edge 继续读取。');
  try { spawn(EDGE_EXECUTABLE, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); }
  catch { return undefined; }
  for (const deadline = Date.now() + 25000; Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 800));
    found = await find();
    if (found) return found;
  }
  return undefined;
}

export async function retryVisibleIfIncomplete(operation, options, headlessResult, { pickProfile = pickVisibleProfile } = {}) {
  const trigger = visibleFallbackReason(headlessResult);
  if (!trigger || (headlessResult?.browser?.retained && !headlessResult.browser.parked)) return headlessResult;
  const saved = await preferences();
  const headlessProfile = process.env.LUZ_HEADLESS_PROFILE;
  const headless = Boolean(headlessProfile && (options.profile === headlessProfile || headlessResult?.browser?.context_id === headlessProfile));
  const savedProfile = saved.reuse_browser_profile === false ? undefined : saved.browser_profile;
  let profile = headless ? savedProfile === headlessProfile ? undefined : savedProfile : options.profile || savedProfile;
  profile ||= await pickProfile(headlessProfile);
  if (!profile) {
    // Without a visible browser the bridge would route to whichever profile is connected, possibly another session's
    // silent browser; keep the silent result instead.
    const fallback = { trigger, initial_status: headlessResult.status, visible_status: 'skipped', visible_error: '没有已连接的可见浏览器，未做可见补读。', visible_window: 'background' };
    const result = { ...headlessResult, visible_fallback: fallback, ...(headless ? { headless_fallback: fallback } : {}) };
    await persistVisibleFallback(result, options);
    return result;
  }
  console.error(`[LuzCrawl] 读取未确认完整（${headlessResult.stop_reason || headlessResult.status}），正在已连接浏览器中后台补读一次。`);
  const previousProfile = process.env.LUZ_VISIBLE_FALLBACK_PROFILE;
  const previousFallback = process.env.LUZ_VISIBLE_FALLBACK;
  let visibleResult;
  let reselectedProfile = false;
  try {
    process.env.LUZ_VISIBLE_FALLBACK_PROFILE = profile || '';
    process.env.LUZ_VISIBLE_FALLBACK = '1';
    const readVisible = () => operation({ ...options, profile, headless: false, window: 'background', resume: true, _luz_visible_fallback: true });
    const disconnected = value => /Browser profile .+ is not connected/i.test(String(value?.message || value?.error || ''));
    try { visibleResult = await readVisible(); }
    catch (error) { if (!disconnected(error)) throw error; visibleResult = {status:'failed',error:error.message}; }
    // Connecting to a stale saved profile did not attempt the website.
    // Select an actually connected visible browser without replaying a site
    // action or changing the user's saved preference.
    if (visibleResult?.status === 'failed' && disconnected(visibleResult)) {
      const connected = await pickProfile(headlessProfile);
      if (connected && connected !== profile) {
        profile = connected; reselectedProfile = true;
        process.env.LUZ_VISIBLE_FALLBACK_PROFILE = profile;
        visibleResult = await readVisible();
      }
    }
  } catch (error) {
    const fallback = { trigger, initial_status: headlessResult.status, visible_status: 'failed', visible_error: error.message, visible_window: 'background' };
    const result = { ...headlessResult, visible_fallback: fallback, ...(headless ? { headless_fallback: fallback } : {}) };
    await persistVisibleFallback(result, options);
    return result;
  } finally {
    if (previousProfile === undefined) delete process.env.LUZ_VISIBLE_FALLBACK_PROFILE;
    else process.env.LUZ_VISIBLE_FALLBACK_PROFILE = previousProfile;
    if (previousFallback === undefined) delete process.env.LUZ_VISIBLE_FALLBACK;
    else process.env.LUZ_VISIBLE_FALLBACK = previousFallback;
  }
  if (visibleResult?.status === 'failed') {
    const fallback = { trigger, initial_status: headlessResult.status, visible_status: visibleResult.status, visible_error: visibleResult.error, visible_window: 'background' };
    const result = { ...headlessResult, visible_fallback: fallback, ...(headless ? { headless_fallback: fallback } : {}) };
    await persistVisibleFallback(result, options);
    return result;
  }
  // Keep the initial result when the visible retry read less, unless the retry stopped for the user and the initial
  // content was never verified.
  const initialVerified = headlessResult?.url_check?.valid_content === true
    || (Array.isArray(headlessResult?.sources) && headlessResult.sources.length > 0 && headlessResult.sources.every(x => x?.url_check?.valid_content === true))
    || (Array.isArray(headlessResult?.candidates) && headlessResult.candidates.length > 0 && !(headlessResult.sources || []).some(x => x?.url_check?.valid_content === false));
  if (captureQuality(visibleResult) < captureQuality(headlessResult) && !(visibleResult?.status === 'awaiting_user' && !initialVerified)) {
    if (visibleResult?.task_id && visibleResult.task_id !== headlessResult?.task_id) {
      try { await cancelTask(visibleResult.task_id); } catch {}
    }
    const fallback = {
      trigger,
      initial_status: headlessResult.status,
      visible_status: visibleResult?.status,
      visible_stop_reason: visibleResult?.stop_reason || visibleResult?.awaiting_reason,
      kept: 'initial_result',
      ...(visibleResult?.folder && visibleResult.folder === headlessResult?.folder ? { same_folder_overwritten: true } : {}),
      visible_window: 'background',
    };
    const result = { ...headlessResult, visible_fallback: fallback, ...(headless ? { headless_fallback: fallback } : {}) };
    await persistVisibleFallback(result, options);
    return result;
  }
  let headlessPendingRemoved = false;
  let cleanupError;
  if (headlessResult?.task_id && headlessResult.task_id !== visibleResult?.task_id) {
    try { await cancelTask(headlessResult.task_id); headlessPendingRemoved = true; }
    catch (error) { cleanupError = error.message; }
  }
  const fallback = {
    trigger,
    initial_status: headlessResult.status,
    initial_stop_reason: headlessResult.stop_reason || headlessResult.awaiting_reason,
    ...(reselectedProfile ? {profile_selection:'reselected_disconnected_profile'} : {}),
    ...(headlessResult.task_id ? { initial_task_id: headlessResult.task_id } : {}),
    ...(headlessPendingRemoved ? { initial_task_removed: true } : {}),
    ...(cleanupError ? { cleanup_error: cleanupError } : {}),
    visible_window: 'background',
  };
  const result = {
    ...visibleResult,
    visible_fallback: fallback,
    ...(headless ? { headless_fallback: {
      trigger,
      headless_status: headlessResult.status,
      headless_stop_reason: headlessResult.stop_reason || headlessResult.awaiting_reason,
      ...(headlessResult.task_id ? { headless_task_id: headlessResult.task_id } : {}),
      ...(headlessPendingRemoved ? { headless_pending_removed: true } : {}),
      ...(cleanupError ? { cleanup_error: cleanupError } : {}),
      visible_window: 'background',
    } } : {}),
  };
  await persistVisibleFallback(result, options);
  return result;
}

export async function withVisibleFallbackOnHeadlessStartFailure(options, operation, runHeadless = withHeadlessSession) {
  let operationStarted = false;
  try {
    return await runHeadless(profile => {
      operationStarted = true;
      return operation({ ...options, headless: false, profile, window: 'background' });
    });
  } catch (error) {
    if (operationStarted) throw error;
    const result = await retryVisibleIfIncomplete(operation, options, { status: 'failed', stop_reason: 'unavailable', error: error.message });
    return result.visible_fallback ? { ...result, headless_fallback: { ...result.visible_fallback, trigger: 'headless_unavailable' } } : result;
  }
}

// Runs operation(contextId, edge) with a dedicated Edge (headless unless headed) on a LuzCrawl-owned profile, then closes
// it. edge is the launch handle from lib/edge.mjs (pid, exited, close()).
export async function withHeadlessSession(operation, { headed = false, startUrl, browser = process.env.LUZ_HEADLESS_BROWSER || 'edge' } = {}) {
  if (browser !== 'edge') throw new Error('The silent browser is Microsoft Edge only; unset LUZ_HEADLESS_BROWSER.');
  await ensureBridgeReady({ timeoutSeconds: 1 }).catch(() => {});
  if (!(await fetchDaemonStatus())) throw new Error('The LuzCrawl bridge daemon did not start; run doctor.');
  const extension = BUNDLED_EXTENSION;
  try { await fs.access(path.join(extension, 'manifest.json')); } catch { throw new Error('The bundled LuzCrawl extension is missing.'); }
  // Concurrent silent sessions each need their own persistent profile: try browser-profile-edge, then -2, -3 and -4,
  // and queue (2 s between rounds) for up to 90 s while all four are locked by other sessions.
  const profileBase = path.join(stateRoot(), 'browser-profile-edge');
  const queueDeadline = Date.now() + 90000;
  let edge;
  for (let slot = 1; ;) {
    try {
      edge = await launchEdge({ userDataDir: slot > 1 ? `${profileBase}-${slot}` : profileBase, extension, headless: !headed, startUrl, downloadsDir: path.join(stateRoot(), 'browser-downloads') });
      break;
    } catch (error) {
      if (headed || !/closed|in use|lock|singleton/i.test(error.message) || (slot >= 4 && Date.now() > queueDeadline)) throw error;
    }
    if (slot >= 4) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      slot = 1;
    } else slot += 1;
  }
  const previousProfile = process.env.LUZ_HEADLESS_PROFILE;
  let profile;
  try {
    // Persistent Edge profiles can retain an older unpacked extension script.
    // Extensions.loadUnpacked at launch already loaded the current extension files from disk.
    profile = await edge.contextId();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await fetchDaemonStatus({ contextId: profile }))?.extensionConnected) {
        // Mark this context as silent so a visible retry never picks it (see pickVisibleProfile).
        await fs.mkdir(path.join(stateRoot(), 'headless-contexts'), { recursive: true });
        await fs.writeFile(path.join(stateRoot(), 'headless-contexts', profile), '');
        if (!headed) process.env.LUZ_HEADLESS_PROFILE = profile;
        return await operation(profile, edge);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('The headless LuzCrawl extension did not connect within 15 seconds.');
  } finally {
    try { if (profile) for (const task of await pendingTasks()) if (task.context_id === profile && task.page && !task.parked) await parkTask(task); }
    finally {
      try { await edge.close(); }
      finally { if (previousProfile === undefined) delete process.env.LUZ_HEADLESS_PROFILE; else process.env.LUZ_HEADLESS_PROFILE = previousProfile; }
    }
  }
}
