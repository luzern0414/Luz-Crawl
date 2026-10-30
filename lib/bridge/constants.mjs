import { VERSION } from '../version.mjs';

// The extension connects to ws://localhost:BRIDGE_PORT/ext; keep in step with browser-extension/dist/background.js.
// OpenCLI's own daemon uses 19825, so both can run side by side.
// LUZ_BRIDGE_PORT exists for tests only; the extension always uses 19835.
export const BRIDGE_PORT = Number(process.env.LUZ_BRIDGE_PORT) || 19835;
export const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
export const BRIDGE_HEADER = 'x-luzcrawl';
// Bump the suffix when the daemon/CLI protocol changes, so a running daemon from an older release is replaced.
export const BRIDGE_VERSION = `${VERSION}+bridge.1`;
export const DEFAULT_CONTEXT_ID = 'default';
export const RESULT_UNKNOWN_CODE = 'command_result_unknown';
export const RESULT_UNKNOWN_HINT = 'Inspect the browser/session state before retrying. Do not blindly retry write commands such as navigate, click, type, or eval.';
export const PROFILE_DISCONNECTED_HINT = 'Open that browser profile and make sure the LuzCrawl extension is enabled, or choose another profile with --profile.';
