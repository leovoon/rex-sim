// Automatic wake of a physical Android phone when its Rex pane gains focus.
//
// Rex runs each app inside a block of a session; the environment identifies
// them (REX_SESSION, REX_BLOCK). While both are set, this module follows the
// session's view events (`rex events -s SESSION --json`) and asks the server
// for fresh view snapshots (`rex api call -s SESSION session.view`) whenever
// the view changes. When a snapshot shows our block focused in the active
// window and sitting in a visible (non-minimized) layer, the onFocus edge
// fires (the app uses it to wake the phone). Leaving the pane fires onBlur.
//
// Everything is best-effort: a missing rex binary, a dead server, a
// malformed line, or wrong-session data never breaks the event stream; the
// listener reconnects with bounded backoff and quietly ignores what it can't
// use. The controller prints nothing (the pane is a full-screen TUI).
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const REX = "rex";
const SNAPSHOT_TIMEOUT_MS = 10000;
const SNAPSHOT_MAX_BUFFER = 2 * 1024 * 1024;

// Ids arrive fully qualified ("session:<uuid>", "block:<uuid>") but the
// environment may carry a shorter form; compare the bare tail.
const tagPrefix = /^[a-z]+:/;
const bareId = (id) => String(id ?? "").trim().replace(tagPrefix, "");
const sessionMatches = (expected, actual) => {
  const a = bareId(expected);
  const b = bareId(actual);
  return Boolean(a) && a === b;
};
const sameBlock = (a, b) => {
  const x = bareId(a);
  const y = bareId(b);
  return Boolean(x) && x === y;
};

// A snapshot shows our pane focused when the active window's focused block is
// ours, no other block is zoomed over it, and the block sits in a layer that
// is drawn (state not "minimized" — a hidden floating pane). Returns false
// for a well-formed snapshot that doesn't focus us, null for an unusable one.
function snapshotFocused(snap, blockId) {
  if (!snap || typeof snap !== "object" || !Array.isArray(snap.windows)) return null;
  if (snap.active_window_id == null) return false;
  const win = snap.windows.find((w) => w && w.window_id === snap.active_window_id);
  if (!win) return false;
  if (win.zoomed_block_id != null && !sameBlock(win.zoomed_block_id, blockId)) return false;
  if (!sameBlock(win.focused_block_id, blockId)) return false;
  const layers = Array.isArray(win.layers) ? win.layers : [];
  return layers.some(
    (layer) =>
      layer && layer.state !== "minimized" &&
      Array.isArray(layer.blocks) &&
      layer.blocks.some((b) => b && sameBlock(b.block_id, blockId))
  );
}

const defaultReadView = (execFileFn) => {
  const run = promisify(execFileFn);
  return (session, opts) =>
    run(REX, ["api", "call", "-s", session, "session.view"], {
      signal: opts.signal,
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: SNAPSHOT_MAX_BUFFER,
    }).then(({ stdout }) => stdout);
};

export class RexFocus {
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.spawn = opts.spawn ?? spawn;
    this.readView = opts.readView ?? defaultReadView(opts.execFile ?? execFile);
    this.onFocus = opts.onFocus ?? null;
    this.onBlur = opts.onBlur ?? null;
    this.onError = opts.onError ?? null;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 5000;
    this.childKillGraceMs = opts.childKillGraceMs ?? 2000;
    this.maxBufferBytes = opts.maxBufferBytes ?? 256 * 1024;
    this.session = String(this.env.REX_SESSION ?? "").trim();
    this.block = String(this.env.REX_BLOCK ?? "").trim();
    this.enabled = Boolean(this.session && this.block);
    this.closed = false;
    this.child = null;
    this.reconnectTimer = null;
    this.retryMs = this.reconnectBaseMs;
    this.buffer = "";
    this.firstDataSeen = false;
    this.inflight = false;
    this.dirty = false;
    this.lastRevision = null;
    this.focused = false;
    this.errorNotified = false;
    this.epoch = 0; // increments per connection; stale query results are discarded
    this.queryAbort = new AbortController();
  }

  start() {
    if (this.closed || !this.enabled) return;
    this.openChild(); // subscribe before the initial query
    this.wantRefresh();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearReconnect();
    this.killChild();
    this.queryAbort.abort(); // cancels the inflight snapshot query
    this.buffer = "";
    this.dirty = false;
  }

  openChild() {
    if (this.closed || this.child) return;
    const proc = this.spawn(REX, ["events", "-s", this.session, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = proc;
    this.firstDataSeen = false;
    // A fresh connection's revisions are not comparable with old ones (the
    // server may have restarted), so accept the next snapshot unconditionally.
    this.lastRevision = null;
    this.epoch++;
    // Partial bytes from the old subscription must not merge into the new
    // stream's first lines.
    this.buffer = "";
    proc.on("error", (err) => this.onChildError(proc, err));
    proc.on("exit", () => this.onChildExit(proc));
    if (proc.stdout) {
      proc.stdout.on("data", (chunk) => this.onChildData(proc, chunk));
      proc.stdout.on("error", () => {});
    }
    if (proc.stderr) proc.stderr.on("data", () => {});
    proc.stdin?.on?.("error", () => {});
  }

  onChildError(proc, err) {
    if (this.closed || this.child !== proc) return; // retired proc: ignore
    // The error does not guarantee the process exited; retire it (kill it if
    // it might still be alive) before any replacement opens, so only one
    // child ever runs.
    this.killChild();
    if (err && err.code === "ENOENT") {
      // Permanent: no rex binary. Disable the feature, report once, and stop.
      this.disablePermanent(err);
      return;
    }
    this.scheduleReconnect();
  }

  onChildExit(proc) {
    if (this.closed || this.child !== proc) return; // retired proc: ignore
    this.child = null;
    this.scheduleReconnect();
  }

  onChildData(proc, chunk) {
    if (this.closed || this.child !== proc) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!this.firstDataSeen) {
      this.firstDataSeen = true;
      this.retryMs = this.reconnectBaseMs;
      // First bytes prove the subscription is attached; one extra refresh
      // closes the gap between the initial query and the attachment. Never
      // refreshed again per connection, so our own CLI calls can't loop.
      this.wantRefresh();
    }
    this.buffer += text;
    if (this.buffer.length > this.maxBufferBytes) this.buffer = "";
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleEventLine(line);
    }
  }

  handleEventLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // malformed line: ignore
    }
    if (!obj || obj.type !== "session_event") return;
    // Only a confirmed event for this session is consumed; missing or foreign
    // session ids (unknown/bad JSON) are ignored and never wake.
    if (!sessionMatches(this.session, obj.payload?.session_id)) return;
    const ev = obj.payload?.event;
    if (!ev || ev.type !== "session_view_changed") return;
    const rev = ev.payload?.revision;
    if (Number.isInteger(rev) && this.lastRevision != null && rev <= this.lastRevision) return;
    this.wantRefresh();
  }

  // One inflight view request at a time; requests that arrive while one is
  // running mark dirty, and the completion re-runs once.
  wantRefresh() {
    if (this.closed || !this.enabled) return;
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    this.runSnapshot()
      .catch(() => {})
      .finally(() => {
        this.inflight = false;
        if (this.dirty && !this.closed) {
          this.dirty = false;
          this.wantRefresh();
        }
      });
  }

  async runSnapshot() {
    const epoch = this.epoch;
    let text;
    try {
      text = await this.readView(this.session, { signal: this.queryAbort.signal });
    } catch {
      return; // transient failure: keep listening, no retry spam
    }
    // A query that started on an earlier connection must not apply after a
    // reconnect: its revision belongs to the old server view.
    if (this.closed || epoch !== this.epoch) return;
    let snap;
    try {
      snap = JSON.parse(text);
    } catch {
      return;
    }
    this.applySnapshot(snap);
  }

  applySnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    // Only a confirmed snapshot of this session can change focus state; a
    // missing or foreign session_id is ignored.
    if (!sessionMatches(this.session, snap.session_id)) return;
    const focused = snapshotFocused(snap, this.block);
    if (focused === null) return;
    if (Number.isInteger(snap.revision)) {
      if (this.lastRevision != null && snap.revision <= this.lastRevision) return;
      this.lastRevision = snap.revision;
    }
    this.setFocused(focused);
  }

  setFocused(focused) {
    if (this.focused === focused) return;
    this.focused = focused;
    if (focused) this.onFocus?.();
    else this.onBlur?.();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.child) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openChild();
      this.wantRefresh(); // resnapshot on the new connection
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  killChild() {
    const proc = this.child;
    this.child = null;
    if (!proc) return;
    if (proc.exitCode != null || proc.signalCode != null) return;
    try {
      proc.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      if (proc.exitCode == null && proc.signalCode == null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }, this.childKillGraceMs).unref?.();
  }

  disablePermanent(err) {
    if (this.closed) return;
    if (!this.errorNotified) {
      this.errorNotified = true;
      this.onError?.(err);
    }
    this.close();
  }
}

// The app-facing wiring: on a focus edge, wake the active physical session
// unless the app is paused or quitting. Inflight wake requests coalesce, and
// rejections are swallowed (never unhandled).
export function createFocusWake(opts) {
  const { getSession, isPaused, isQuitting } = opts;
  let closed = false;
  let focused = false;
  let inflight = false;
  let pending = null; // latest focus gain awaiting an inflight wake (coalesced)

  // True while the controller is live, the pane is focused, the app is not
  // paused/quitting, and the session is a physical Android one.
  const live = (session) =>
    !closed && focused && !isPaused() && !isQuitting() &&
    session && session.device?.platform === "android-physical";

  const dispatch = (session) => {
    inflight = true;
    Promise.resolve()
      .then(() => {
        // Recheck eligibility right before the wake dispatch: a pause, blur,
        // close, or a changed session before this microtask must never wake an
        // obsolete phone.
        if (!live(session) || getSession() !== session) return;
        return session.wake?.();
      })
      .catch(() => {})
      .finally(() => {
        inflight = false;
        if (pending && live(pending.session) && getSession() === pending.session) {
          const p = pending;
          pending = null;
          dispatch(p.session);
        }
      });
  };

  const maybeWake = () => {
    if (closed) return;
    const session = getSession();
    if (!session || session.device?.platform !== "android-physical" || isPaused() || isQuitting()) return;
    focused = true;
    if (inflight) {
      pending = { session }; // the latest focus gain coalesces into one follow-up
      return;
    }
    dispatch(session);
  };

  const maybeBlur = () => {
    focused = false;
    pending = null; // a queued-but-not-dispatched wake must not fire after blur
  };

  const FocusClass = opts.RexFocus ?? RexFocus;
  const focus = new FocusClass({ ...opts, onFocus: maybeWake, onBlur: maybeBlur });
  return {
    focus,
    maybeWake,
    close: () => {
      closed = true;
      focused = false;
      pending = null;
      focus.close();
    },
  };
}
