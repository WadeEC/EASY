// Tiny in-memory event bus used to fan-out live updates over Server-Sent Events.
// Each subscriber gets every event after it subscribes. No persistence — if a
// client disconnects, it'll catch up on next poll/page reload, which is fine
// for a single-process Node app (Render, local Mac, etc.).
//
// Usage:
//   import { emit, subscribe } from "./event-bus.js";
//   emit("checkin", { player_id: 17, week: "2026-09-06" });
//   const off = subscribe((e) => console.log(e.kind, e.payload));
//   off();   // stops listening

const _listeners = new Set();
let _nextId = 1;

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function emit(kind, payload = {}) {
  const evt = { id: _nextId++, ts: Date.now(), kind, payload };
  // Fan-out is intentionally fire-and-forget. Any subscriber that throws gets
  // logged but doesn't block the others.
  for (const fn of _listeners) {
    try { fn(evt); }
    catch (e) { console.warn("[event-bus]", e?.message || e); }
  }
  return evt;
}

// Helper for short status snapshots (debug/health).
export function listenerCount() { return _listeners.size; }
