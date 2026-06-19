// "Poor man's debugging": one prefixed, always-on diagnostic channel shared by
// the background event page and the UI pages. Lifecycle breadcrumbs (page
// load/wake, port connect/disconnect, keepalive heartbeat, job phase changes)
// land together in Thunderbird's error console, so an event-page suspension
// shows up after the fact as a gap in the keepalive heartbeat followed by a
// fresh "background loaded" line — exactly the trail that was missing when a run
// silently stalled.

const PREFIX = "[SmarterMailSort]";

export function log(...args: unknown[]): void {
  console.info(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function logError(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
