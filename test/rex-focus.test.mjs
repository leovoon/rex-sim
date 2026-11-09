import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { ADB } from "../src/adb-input.mjs";
import { wakePhysicalDevice, physicalWake } from "../src/physical.mjs";
import { RexFocus, createFocusWake } from "../src/rex-focus.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake ChildProcess for the injected spawn: EventEmitter + pipe-like
// stdout/stderr/stdin and kill/finish following Node's exit-code semantics.
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = [];
    this.kill = (sig) => {
      this.killed.push(sig);
      if (this.exitCode == null && this.signalCode == null) this.finish(null, sig);
    };
  }

  finish(code = 0, signal = null) {
    if (this.exitCode != null || this.signalCode != null) return;
    this.exitCode = signal == null ? code : null;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, signal);
  }

  data(chunk) {
    this.stdout.emit("data", chunk);
  }

  fail(err) {
    this.emit("error", err);
  }
}

const tiled = (block, over = {}) => ({ kind: "tiled", blocks: [{ block_id: block }], ...over });
const snap = (revision, over = {}) => ({
  revision,
  session_id: "session:s1",
  active_window_id: "window:w1",
  windows: [{ window_id: "window:w1", focused_block_id: "block:b1", layers: [tiled("block:b1")] }],
  ...over,
});
const ev = (revision, over = {}) => JSON.stringify({
  type: "session_event",
  payload: {
    session_id: "session:s1",
    event: { type: "session_view_changed", payload: { revision } },
  },
  ...over,
}) + "\n";

function harness(overrides = {}) {
  const children = [];
  const readCount = { n: 0 };
  const state = { current: overrides.current ?? snap(1) };
  const spawn = overrides.spawn ?? ((cmd, args) => {
    const child = new FakeChild();
    child.cmd = cmd;
    child.args = args;
    children.push(child);
    return child;
  });
  const readView = overrides.readView ?? (async () => {
    readCount.n++;
    return JSON.stringify(state.current);
  });
  const focus = new RexFocus({
    env: overrides.env ?? { REX_SESSION: "session:s1", REX_BLOCK: "block:b1" },
    spawn,
    readView,
    reconnectBaseMs: overrides.reconnectBaseMs ?? 20,
    reconnectMaxMs: overrides.reconnectMaxMs ?? 60,
    childKillGraceMs: overrides.childKillGraceMs ?? 25,
    onFocus: overrides.onFocus ?? (() => {}),
    onBlur: overrides.onBlur ?? (() => {}),
    onError: overrides.onError ?? (() => {}),
  });
  return { focus, children, state, readCount };
}

test("start() outside a Rex session is a no-op", async () => {
  const { focus, children, readCount } = harness({ env: { REX_BLOCK: "block:b1" } });
  focus.start();
  await sleep(30);
  assert.equal(children.length, 0);
  assert.equal(readCount.n, 0);
});

test("initial focused snapshot fires one focus edge; repeats don't; blur and regain do", async () => {
  const events = [];
  const { focus, children, state } = harness({
    onFocus: () => events.push("focus"),
    onBlur: () => events.push("blur"),
  });
  state.current = snap(1);
  focus.start();
  await sleep(30);
  assert.deepEqual(events, ["focus"]);

  state.current = snap(2);
  children[0].data(ev(2));
  await sleep(30);
  assert.deepEqual(events, ["focus"]); // same focus again: no edge

  state.current = snap(3, {
    windows: [{ window_id: "window:w1", focused_block_id: "block:b2", layers: [tiled("block:b2")] }],
  });
  children[0].data(ev(3));
  await sleep(30);
  assert.deepEqual(events, ["focus", "blur"]);

  state.current = snap(4);
  children[0].data(ev(4));
  await sleep(30);
  assert.deepEqual(events, ["focus", "blur", "focus"]);
});

test("switching the active window away and back blurs and refocuses", async () => {
  const events = [];
  const { focus, children, state } = harness({
    onFocus: () => events.push("focus"),
    onBlur: () => events.push("blur"),
  });
  const w1 = { window_id: "window:w1", focused_block_id: "block:b1", layers: [tiled("block:b1")] };
  const w2 = { window_id: "window:w2", focused_block_id: "block:b2", layers: [tiled("block:b2")] };
  state.current = snap(1, { active_window_id: "window:w1", windows: [w1, w2] });
  focus.start();
  await sleep(30);
  assert.deepEqual(events, ["focus"]);

  state.current = snap(2, { active_window_id: "window:w2", windows: [w1, w2] });
  children[0].data(ev(2));
  await sleep(30);
  assert.deepEqual(events, ["focus", "blur"]);

  state.current = snap(3, { active_window_id: "window:w1", windows: [w1, w2] });
  children[0].data(ev(3));
  await sleep(30);
  assert.deepEqual(events, ["focus", "blur", "focus"]);
});

test("minimized, zoomed-other, and missing-block panes never focus; zoomed-self and visible floating do", async () => {
  const cases = [
    {
      name: "minimized floating layer only",
      snapshot: snap(1, {
        windows: [{
          window_id: "window:w1",
          focused_block_id: "block:b1",
          layers: [{ kind: "floating", state: "minimized", blocks: [{ block_id: "block:b1" }] }],
        }],
      }),
      focused: false,
    },
    {
      name: "minimized plus tiled layer",
      snapshot: snap(1, {
        windows: [{
          window_id: "window:w1",
          focused_block_id: "block:b1",
          layers: [
            { kind: "floating", state: "minimized", blocks: [{ block_id: "block:b1" }] },
            tiled("block:b1"),
          ],
        }],
      }),
      focused: true,
    },
    {
      name: "another block zoomed",
      snapshot: snap(1, {
        windows: [{
          window_id: "window:w1",
          focused_block_id: "block:b1",
          zoomed_block_id: "block:b2",
          layers: [tiled("block:b1")],
        }],
      }),
      focused: false,
    },
    {
      name: "our block zoomed",
      snapshot: snap(1, {
        windows: [{
          window_id: "window:w1",
          focused_block_id: "block:b1",
          zoomed_block_id: "block:b1",
          layers: [tiled("block:b1")],
        }],
      }),
      focused: true,
    },
    {
      name: "block missing from layers",
      snapshot: snap(1, {
        windows: [{ window_id: "window:w1", focused_block_id: "block:b1", layers: [tiled("block:b2")] }],
      }),
      focused: false,
    },
    {
      name: "visible floating layer",
      snapshot: snap(1, {
        windows: [{
          window_id: "window:w1",
          focused_block_id: "block:b1",
          layers: [{ kind: "floating", blocks: [{ block_id: "block:b1" }] }],
        }],
      }),
      focused: true,
    },
  ];
  for (const c of cases) {
    const events = [];
    const { focus, state } = harness({ onFocus: () => events.push("focus") });
    state.current = c.snapshot;
    focus.start();
    await sleep(30);
    assert.deepEqual(events, c.focused ? ["focus"] : [], c.name);
  }
});

test("events from other sessions and stale revisions are ignored; newer revisions refresh", async () => {
  const { focus, children, state, readCount } = harness();
  focus.start();
  await sleep(30);
  children[0].data("client_connected\n"); // consume the one-time first-data refresh
  await sleep(30);
  const before = readCount.n;

  children[0].data(ev(2, { payload: { session_id: "session:other", event: { type: "session_view_changed", payload: { revision: 2 } } } }));
  await sleep(30);
  assert.equal(readCount.n, before);

  children[0].data(ev(1));
  await sleep(30);
  assert.equal(readCount.n, before); // stale revision

  state.current = snap(2);
  children[0].data(ev(2));
  await sleep(30);
  assert.equal(readCount.n, before + 1);
});

test("out-of-order snapshots are ignored", async () => {
  const events = [];
  const { focus, children, state } = harness({
    onFocus: () => events.push("focus"),
    onBlur: () => events.push("blur"),
  });
  state.current = snap(5);
  focus.start();
  await sleep(30);
  assert.deepEqual(events, ["focus"]);

  state.current = snap(4, {
    windows: [{ window_id: "window:w1", focused_block_id: "block:b2", layers: [tiled("block:b2")] }],
  });
  children[0].data(ev(6)); // newer event asks for a refresh
  await sleep(30);
  assert.deepEqual(events, ["focus"]); // the stale rev4 snapshot is ignored
});

test("malformed and split JSON lines are handled; the buffer bounds stale data", async () => {
  const { focus, children, state, readCount } = harness();
  focus.start();
  await sleep(30);
  children[0].data("client_connected\n"); // consume the one-time first-data refresh
  await sleep(30);
  const before = readCount.n;

  const line = ev(2);
  state.current = snap(2);
  children[0].data(line.slice(0, 20));
  children[0].data(line.slice(20)); // the event already ends with a newline
  await sleep(30);
  assert.equal(readCount.n, before + 1);

  children[0].data("not json\n{bad}\n");
  children[0].data(JSON.stringify({ type: "other" }) + "\n");
  children[0].data(JSON.stringify({ type: "session_event", payload: { session_id: "session:s1", event: { type: "client_connected" } } }) + "\n");
  await sleep(30);
  assert.equal(readCount.n, before + 1);

  // A flood without a newline exceeds the buffer bound and is dropped, but a
  // later complete line still parses.
  children[0].data("x".repeat(300 * 1024));
  state.current = snap(3);
  children[0].data(ev(3) + "\n");
  await sleep(30);
  assert.equal(readCount.n, before + 2);
});

test("first event data triggers exactly one refresh to close the subscription race", async () => {
  const deferred = [];
  const readView = () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    deferred.push({ resolve });
    return p;
  };
  const events = [];
  const { focus, children } = harness({ readView, onFocus: () => events.push("focus") });
  focus.start();
  await sleep(10);
  assert.equal(deferred.length, 1); // initial query inflight

  children[0].data("client_connected\n");
  await sleep(10);
  assert.equal(deferred.length, 1); // coalesced behind the inflight query

  deferred[0].resolve(JSON.stringify(snap(1)));
  await sleep(30);
  assert.equal(deferred.length, 2); // the first-data refresh ran exactly once
  assert.deepEqual(events, ["focus"]);

  children[0].data("client_connected\n");
  children[0].data("client_connected\n");
  await sleep(30);
  assert.equal(deferred.length, 2); // no per-line refresh spam

  deferred[1].resolve(JSON.stringify(snap(1)));
  await sleep(30);
  assert.deepEqual(events, ["focus"]); // same snapshot: no new edge
});

test("bursts coalesce into one inflight view request, rerunning once while dirty", async () => {
  const deferred = [];
  const readView = () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    deferred.push({ resolve });
    return p;
  };
  const { focus, children } = harness({ readView });
  focus.start();
  await sleep(10);
  for (let r = 2; r <= 10; r++) children[0].data(ev(r) + "\n");
  await sleep(10);
  assert.equal(deferred.length, 1);

  deferred[0].resolve(JSON.stringify(snap(1)));
  await sleep(30);
  assert.equal(deferred.length, 2);

  deferred[1].resolve(JSON.stringify(snap(10)));
  await sleep(30);
  assert.equal(deferred.length, 2);
});

test("an events child that dies reconnects with capped exponential backoff", async () => {
  const { focus, children } = harness();
  focus.start();
  await sleep(30);
  assert.equal(children.length, 1);

  children[0].finish(0);
  await sleep(35); // base 20ms
  assert.equal(children.length, 2);

  children[1].finish(1);
  await sleep(55); // doubled 40ms
  assert.equal(children.length, 3);

  children[2].finish(1);
  await sleep(75); // capped at 60ms
  assert.equal(children.length, 4);
});

test("reconnect preserves focus state; a resnapshot of the same focus fires no new edge", async () => {
  const events = [];
  const { focus, children, state } = harness({
    onFocus: () => events.push("focus"),
    onBlur: () => events.push("blur"),
  });
  state.current = snap(1);
  focus.start();
  await sleep(30);
  assert.deepEqual(events, ["focus"]);

  children[0].finish(0);
  await sleep(30);
  assert.equal(children.length, 2); // reconnected
  await sleep(30);
  assert.deepEqual(events, ["focus"]); // same focus after resnapshot: no edge

  state.current = snap(3, {
    windows: [{ window_id: "window:w1", focused_block_id: "block:b2", layers: [tiled("block:b2")] }],
  });
  children[1].data(ev(3));
  await sleep(30);
  assert.deepEqual(events, ["focus", "blur"]);
});

test("permanent missing rex disables the feature with one notice, no retry spam", async () => {
  const notices = [];
  const { focus, children } = harness({ onError: (e) => notices.push(e.code) });
  focus.start();
  await sleep(10);
  children[0].fail(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  await sleep(60);
  assert.equal(notices.length, 1);
  assert.equal(children.length, 1); // no retry respawn
  assert.equal(focus.closed, true);
});

test("non-ENOENT spawn errors reconnect", async () => {
  const { focus, children } = harness();
  focus.start();
  await sleep(10);
  children[0].fail(new Error("EPIPE"));
  await sleep(35);
  assert.equal(children.length, 2);
});

test("close kills the child (SIGTERM then SIGKILL fallback) and is idempotent", async () => {
  const children = [];
  const spawn = () => {
    const c = new FakeChild();
    c.kill = (sig) => c.killed.push(sig); // ignores SIGTERM, so the fallback must fire
    children.push(c);
    return c;
  };
  const { focus } = harness({ spawn });
  focus.start();
  await sleep(10);
  focus.close();
  await sleep(60); // grace 25ms
  assert.deepEqual(children[0].killed, ["SIGTERM", "SIGKILL"]);
  focus.close(); // idempotent
});

test("close while a view request is pending aborts it and prevents late callbacks", async () => {
  let aborted = false;
  const readView = (session, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => {}); // never resolves on its own
  };
  const events = [];
  const { focus, children } = harness({ readView, onFocus: () => events.push("focus") });
  focus.start();
  await sleep(10);
  focus.close();
  assert.equal(aborted, true);
  assert.deepEqual(children[0].killed, ["SIGTERM"]);
  await sleep(80);
  assert.equal(children.length, 1); // no reconnect respawn
  assert.deepEqual(events, []);
});

test("close clears a pending reconnect", async () => {
  const { focus, children } = harness();
  focus.start();
  await sleep(10);
  children[0].finish(0); // schedules a reconnect
  await sleep(5);
  focus.close();
  await sleep(60);
  assert.equal(children.length, 1);
});

test("a deferred view from an old connection cannot apply after reconnect; the new connection still refreshes", async () => {
  const deferred = [];
  const readView = () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    deferred.push({ resolve });
    return p;
  };
  const events = [];
  const { focus, children } = harness({ readView, onFocus: () => events.push("focus") });
  focus.start();
  await sleep(10);
  assert.equal(deferred.length, 1); // initial query on connection 1

  children[0].finish(0); // connection 1 dies mid-query
  await sleep(40); // reconnect opens connection 2; its refresh waits behind the inflight query
  assert.equal(children.length, 2);
  assert.equal(deferred.length, 1); // still only the stale query; the new refresh is dirty-pending

  deferred[0].resolve(JSON.stringify(snap(100))); // stale old-server revision 100
  await sleep(30);
  assert.equal(deferred.length, 2); // the dirty refresh now runs on the new connection
  assert.deepEqual(events, []); // revision 100 was discarded, not applied

  deferred[1].resolve(JSON.stringify(snap(1))); // fresh new-server revision 1
  await sleep(30);
  assert.deepEqual(events, ["focus"]); // accepted despite the stale revision 100

  children[1].data(ev(2)); // later events still refresh normally
  await sleep(30);
  assert.equal(deferred.length, 3);
  deferred[2].resolve(JSON.stringify(snap(2)));
  await sleep(30);
});

test("a partial line from an old connection cannot contaminate the new subscription", async () => {
  const deferred = [];
  const readView = () => {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    deferred.push({ resolve });
    return p;
  };
  const { focus, children } = harness({ readView });
  focus.start();
  await sleep(10);
  deferred[0].resolve(JSON.stringify(snap(1)));
  await sleep(30);

  children[0].data('{"type":"session_event","payload":{"session_id":"session:s1","event":{"type":"session_view_changed","payload":{"revision":');
  children[0].finish(0);
  await sleep(40); // connection 2 opens; its refresh waits behind the old first-data refresh
  assert.equal(children.length, 2);
  // Settle the old first-data refresh and the reconnect refresh (each rerun
  // may add a query until the chain stabilizes).
  let last = -1;
  while (deferred.length !== last) {
    last = deferred.length;
    deferred[deferred.length - 1].resolve(JSON.stringify(snap(1)));
    await sleep(30);
  }
  assert.equal(deferred.length, 3); // old first-data + reconnect refreshes settled

  children[1].data(ev(2)); // a complete event on the new connection
  await sleep(30);
  assert.equal(deferred.length, 4); // the new connection's first-data refresh
  deferred[3].resolve(JSON.stringify(snap(2)));
  await sleep(30);
  assert.equal(deferred.length, 5); // the event parsed cleanly -> the dirty rerun ran
  deferred[4].resolve(JSON.stringify(snap(2)));
  await sleep(30);
});

const unfocused = (revision) =>
  snap(revision, {
    windows: [{ window_id: "window:w1", focused_block_id: "block:b2", layers: [tiled("block:b2")] }],
  });

test("events and snapshots without a session id never wake", async () => {
  const events = [];
  const { focus, children, state, readCount } = harness({
    current: unfocused(1),
    onFocus: () => events.push("focus"),
    onBlur: () => events.push("blur"),
  });
  focus.start();
  await sleep(30);
  children[0].data("client_connected\n");
  await sleep(30);
  const before = readCount.n;

  // An event without session_id is ignored.
  children[0].data(ev(2, { payload: { event: { type: "session_view_changed", payload: { revision: 2 } } } }));
  await sleep(30);
  assert.equal(readCount.n, before);
  assert.deepEqual(events, []);

  // A snapshot without session_id is ignored, even when fetched by a valid event.
  state.current = snap(2, { session_id: undefined });
  children[0].data(ev(3));
  await sleep(30);
  assert.equal(readCount.n, before + 1); // refreshed
  assert.deepEqual(events, []); // but the anonymous snapshot did not wake
});

test("a spawn error retires the old child before opening a replacement", async () => {
  const { focus, children } = harness();
  focus.start();
  await sleep(10);
  assert.equal(children.length, 1);
  children[0].fail(new Error("EPIPE"));
  await sleep(5);
  assert.ok(children[0].killed.includes("SIGTERM"), "errored child should be retired");
  await sleep(35);
  assert.equal(children.length, 2); // a single replacement, nothing overlapping
});

test("callbacks from a retired child are ignored", async () => {
  const { focus, children } = harness();
  focus.start();
  await sleep(30);
  children[0].finish(0);
  await sleep(35);
  assert.equal(children.length, 2);
  children[0].emit("exit", 1, null); // late exit from the retired child
  children[0].fail(new Error("late error"));
  await sleep(70); // beyond the max backoff
  assert.equal(children.length, 2); // no third child
});

test("double start does not spawn two children; data events never restart the child", async () => {
  const { focus, children, state } = harness();
  focus.start();
  focus.start();
  await sleep(10);
  assert.equal(children.length, 1);
  state.current = snap(2);
  children[0].data(ev(2) + "\n");
  children[0].data(ev(3) + "\n");
  await sleep(30);
  assert.equal(children.length, 1);
});

function wakeCtlHarness() {
  const state = { paused: false, quitting: false, session: null };
  const wakes = [];
  const ctl = createFocusWake({
    getSession: () => state.session,
    isPaused: () => state.paused,
    isQuitting: () => state.quitting,
    RexFocus: class {
      constructor(opts) {
        this.onFocus = opts.onFocus;
        this.onBlur = opts.onBlur;
      }
      start() {}
      close() {}
    },
  });
  return { ctl, state, wakes };
}

test("focus wake controller wakes only physical sessions, honoring paused/quitting", async () => {
  const { ctl, state, wakes } = wakeCtlHarness();
  state.session = { device: { platform: "android-physical" }, wake: () => wakes.push("wake") };
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]);

  state.paused = true;
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]); // paused: no wake

  state.paused = false;
  state.quitting = true;
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]); // quitting: no wake

  state.quitting = false;
  state.session = { device: { platform: "ios" }, wake: () => wakes.push("wake") };
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]); // non-physical: no wake

  state.session = null;
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]); // no session: no wake

  state.session = { device: { platform: "android-physical" } }; // no wake method
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]);
});

test("focus wake controller coalesces inflight wake requests and swallows rejections", async () => {
  const { ctl, state, wakes } = wakeCtlHarness();
  let release;
  const gate = new Promise((r) => { release = r; });
  state.session = { device: { platform: "android-physical" }, wake: () => { wakes.push("wake"); return gate; } };
  ctl.focus.onFocus();
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]);
  ctl.focus.onFocus(); // arrives while the first is inflight
  await sleep(10);
  assert.deepEqual(wakes, ["wake"]);
  release();
  await sleep(30);
  assert.deepEqual(wakes, ["wake", "wake"]); // coalesced into one follow-up

  state.session.wake = () => Promise.reject(new Error("adb down"));
  ctl.focus.onFocus();
  await sleep(30); // rejection swallowed: no unhandled rejection, no extra wake
  assert.deepEqual(wakes, ["wake", "wake"]);
});

test("closing the focus wake controller cancels a queued wake", async () => {
  const { ctl, state, wakes } = wakeCtlHarness();
  let release;
  const gate = new Promise((r) => { release = r; });
  state.session = { device: { platform: "android-physical" }, wake: () => { wakes.push("wake"); return gate; } };
  ctl.focus.onFocus();
  await sleep(10);
  ctl.focus.onFocus(); // queued behind the inflight wake
  ctl.close();
  release();
  await sleep(30);
  assert.deepEqual(wakes, ["wake"]); // the queued wake never dispatches
});

test("blurring cancels a queued-but-not-dispatched wake", async () => {
  const { ctl, state, wakes } = wakeCtlHarness();
  let release;
  const gate = new Promise((r) => { release = r; });
  state.session = { device: { platform: "android-physical" }, wake: () => { wakes.push("wake"); return gate; } };
  ctl.focus.onFocus();
  await sleep(10);
  ctl.focus.onFocus(); // queued
  ctl.focus.onBlur(); // blur cancels the queued wake
  release();
  await sleep(30);
  assert.deepEqual(wakes, ["wake"]);
});

test("eligibility is rechecked at dispatch: paused or a changed session before the microtask never wakes an obsolete phone", async () => {
  const { ctl, state, wakes } = wakeCtlHarness();
  state.session = { device: { platform: "android-physical" }, wake: () => wakes.push("wake") };
  ctl.focus.onFocus();
  state.paused = true; // before the dispatch microtask runs
  await sleep(30);
  assert.deepEqual(wakes, []);

  state.paused = false;
  state.session = { device: { platform: "android-physical" }, wake: () => wakes.push("wake2") };
  ctl.focus.onFocus();
  state.session = { device: { platform: "ios" }, wake: () => wakes.push("wake2") }; // replaced before the microtask
  await sleep(30);
  assert.deepEqual(wakes, []); // the obsolete session was not woke
});

test("wakePhysicalDevice sends adb keyevent 224 with a bounded timeout", async () => {
  const calls = [];
  const ok = await wakePhysicalDevice("S1", {
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: "" };
    },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, ADB);
  assert.deepEqual(calls[0].args, ["-s", "S1", "shell", "input", "keyevent", "224"]);
  assert.ok(calls[0].opts.timeout > 0);
});

test("wakePhysicalDevice fails quietly", async () => {
  const ok = await wakePhysicalDevice("S1", { run: async () => { throw new Error("adb down"); } });
  assert.equal(ok, false);
});

test("physicalWake wakes with keyevent 224 and skips once closed", async () => {
  const state = { closed: false };
  const calls = [];
  const wake = physicalWake("S1", {
    isClosed: () => state.closed,
    run: async (cmd, args) => {
      calls.push(args);
      return {};
    },
  });
  assert.equal(await wake(), true);
  assert.deepEqual(calls, [["-s", "S1", "shell", "input", "keyevent", "224"]]);
  state.closed = true;
  assert.equal(await wake(), false);
  assert.equal(calls.length, 1);
});
