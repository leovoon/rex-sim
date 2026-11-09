// Native input over scrcpy's control channel, instead of one `adb shell
// input` process per event.
//
// scrcpy's server (scrcpy-server.jar) is pushed to the device and started
// with `video=false audio=false control=true`, so it binds a local abstract
// socket named "scrcpy" (scid=-1) and waits for exactly one connection. We
// `adb forward` a local TCP port to it and speak the control protocol, which
// the client and server share; the wire format below mirrors the server's
// ControlMessageReader.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { ADB, MODIFIERS } from "./adb-input.mjs";

const run = promisify(execFile);
// scid is a 31-bit non-negative value; the socket name is its 8-hex-digit form.
const randomSocketName = () => `scrcpy_${Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, "0")}`;

// Message types (app/src/control_msg.h).
const TYPE = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
};

// Android metastates.
export const META = { SHIFT: 0x1, ALT: 0x2, META: 0x4, CTRL: 0x1000 };

export const ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function keyMsg(action, keycode, repeat = 0, meta = 0) {
  const b = Buffer.alloc(14);
  b[0] = TYPE.INJECT_KEYCODE;
  b[1] = action;
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(meta, 10);
  return b;
}

export function textMsg(text) {
  const s = Buffer.from(text, "utf8");
  const b = Buffer.alloc(5 + s.length);
  b[0] = TYPE.INJECT_TEXT;
  b.writeInt32BE(s.length, 1);
  s.copy(b, 5);
  return b;
}

export function touchMsg(action, pointerId, x, y, screenWidth, screenHeight, pressure = 1, actionButton = 0, buttons = 0) {
  const b = Buffer.alloc(32);
  b[0] = TYPE.INJECT_TOUCH_EVENT;
  b[1] = action;
  b.writeBigInt64BE(BigInt(pointerId), 2);
  b.writeInt32BE(Math.round(x), 10);
  b.writeInt32BE(Math.round(y), 14);
  b.writeUInt16BE(screenWidth, 18);
  b.writeUInt16BE(screenHeight, 20);
  b.writeUInt16BE(Math.round(clamp01(pressure) * 0xffff), 22);
  b.writeInt32BE(actionButton, 24);
  b.writeInt32BE(buttons, 28);
  return b;
}

// hscroll/vscroll are in screen fractions, clamped to [-1, 1]; the server
// decodes an i16 fixed point and scales by 16.
export function scrollMsg(x, y, screenWidth, screenHeight, hscroll = 0, vscroll = 0, buttons = 0) {
  const b = Buffer.alloc(21);
  b[0] = TYPE.INJECT_SCROLL_EVENT;
  b.writeInt32BE(Math.round(x), 1);
  b.writeInt32BE(Math.round(y), 5);
  b.writeUInt16BE(screenWidth, 9);
  b.writeUInt16BE(screenHeight, 11);
  const fixed = (v) => Math.round(Math.min(1, Math.max(-1, v)) * 0x7fff);
  b.writeInt16BE(fixed(hscroll), 13);
  b.writeInt16BE(fixed(vscroll), 15);
  b.writeInt32BE(buttons, 17);
  return b;
}

export const rotateMsg = () => Buffer.from([TYPE.ROTATE_DEVICE]);
export const backOrScreenOnMsg = (action) => Buffer.from([TYPE.BACK_OR_SCREEN_ON, action]);

export function uhidCreateMsg(id, vendorId, productId, name, reportDesc) {
  const n = Buffer.from(name, "utf8");
  const b = Buffer.alloc(1 + 2 + 2 + 2 + 1 + n.length + 2 + reportDesc.length);
  let o = 0;
  b[o++] = TYPE.UHID_CREATE;
  b.writeUInt16BE(id, o); o += 2;
  b.writeUInt16BE(vendorId, o); o += 2;
  b.writeUInt16BE(productId, o); o += 2;
  b[o++] = n.length;
  n.copy(b, o); o += n.length;
  b.writeUInt16BE(reportDesc.length, o); o += 2;
  reportDesc.copy(b, o);
  return b;
}

export function uhidInputMsg(id, data) {
  const b = Buffer.alloc(1 + 2 + 2 + data.length);
  b[0] = TYPE.UHID_INPUT;
  b.writeUInt16BE(id, 1);
  b.writeUInt16BE(data.length, 3);
  data.copy(b, 5);
  return b;
}

export const uhidDestroyMsg = (id) => {
  const b = Buffer.alloc(3);
  b[0] = TYPE.UHID_DESTROY;
  b.writeUInt16BE(id, 1);
  return b;
};

// A composite UHID device with three reports: keyboard (1), relative mouse
// (2) and consumer controls (3). This is the path scrcpy recommends for OEMs
// that block the classic input injection.
export const UHID_DESCRIPTOR = Buffer.from([
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, // generic desktop, keyboard, application
  0x85, 0x01,                           // report id 1
  0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // modifiers
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01, // reserved
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,
  0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
  0xC0,
  0x05, 0x01, 0x09, 0x02, 0xA1, 0x01, // mouse
  0x85, 0x02,
  0x09, 0x01, 0xA1, 0x00,
  0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03, 0x75, 0x01, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x05, 0x81, 0x01,
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7F, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06,
  0xC0, 0xC0,
  0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, // consumer
  0x85, 0x03,
  0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x29, 0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x02,
  0xC0,
]);

// Consumer usages we emit through report 3.
export const CONSUMER = { home: 0x40, volumeUp: 0xE9, volumeDown: 0xEA };

function serverJarPath() {
  const env = process.env.REX_SIM_SCRCPY_SERVER;
  if (env && existsSync(env)) return env;
  const cmd = process.env.REX_SIM_SCRCPY || "scrcpy";
  const candidates = ["/opt/homebrew/share/scrcpy/scrcpy-server", "/usr/local/share/scrcpy/scrcpy-server"];
  const which = spawnSync("sh", ["-c", `command -v "${cmd}"`]).stdout.toString().trim();
  if (which) candidates.unshift(`${dirname(which)}/../share/scrcpy/scrcpy-server`);
  return candidates.find(existsSync) ?? null;
}

function scrcpyVersion() {
  const cmd = process.env.REX_SIM_SCRCPY || "scrcpy";
  const out = spawnSync(cmd, ["--version"]).stdout.toString();
  return /scrcpy (\S+)/.exec(out)?.[1] ?? null;
}

// Dial the forwarded endpoint until the scrcpy server has actually spoken: a
// local TCP connect (adb forward) only proves adb's endpoint exists, not that
// the on-device server is ready. The server sends one dummy byte when
// send_dummy_byte=true; we consume exactly that byte (read(1), leaving the
// rest buffered and the socket paused) and resolve. Attempts that close or
// error before the dummy byte are retried, with one retry per failed attempt
// and an overall deadline including accepted-but-silent connections.
export function connectWithRetry(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`scrcpy control socket didn't accept a connection`));
        return;
      }
      const socket = net.connect(port, "127.0.0.1");
      let finished = false;
      const idleTimer = setTimeout(() => fall(), Math.max(0, deadline - Date.now()));
      // Only our named handshake listeners are removed on settle; the
      // socket's own internal listeners (notably end handling) stay intact.
      const detach = () => {
        clearTimeout(idleTimer);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("readable", onReadable);
      };
      const fall = () => {
        if (finished) return;
        finished = true;
        detach();
        socket.destroy();
        setTimeout(attempt, 250); // exactly one retry per failed attempt
      };
      const succeed = () => {
        if (finished) return;
        finished = true;
        detach();
        resolve(socket);
      };
      const onError = () => fall();
      const onClose = () => fall();
      const onReadable = () => {
        const dummy = socket.read(1);
        if (dummy && dummy.length === 1) {
          if (dummy[0] === 0) succeed(); // the documented handshake byte
          else fall(); // malformed dummy: fail this attempt, retry
        }
        // else keep waiting: more data or a close will follow
      };
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("readable", onReadable);
    };
    attempt();
  });
}

// The server parses video_bit_rate as a plain integer of bits per second;
// the M suffix is a client-side convenience.
const bitrateToInt = (v) => {
  const m = /^(\d+)([kKmM]?)$/.exec(String(v));
  if (!m) return 4000000;
  const n = Number(m[1]);
  if (m[2] === "k" || m[2] === "K") return n * 1000;
  if (m[2] === "m" || m[2] === "M") return n * 1000000;
  return n;
};

// Starts a video-only scrcpy server with raw stream meta disabled, forwards
// its socket, and resolves with a connected net.Socket carrying the raw
// codec bitstream (Annex B). This is what the client normally decodes; we
// hand it straight to ffmpeg, skipping any container.
export async function startVideoSocket(serial, q = {}, opts = {}) {
  const jar = serverJarPath();
  if (!jar) throw new Error("couldn't find scrcpy-server.jar (set REX_SIM_SCRCPY_SERVER)");
  const version = scrcpyVersion();
  if (!version) throw new Error("scrcpy not found");
  const jarRemote = `/data/local/tmp/scrcpy-server-v-${process.pid}-${Math.floor(Math.random() * 0xffffff).toString(16)}.jar`;
  await run(ADB, ["-s", serial, "push", jar, jarRemote]);
  const socketName = randomSocketName();
  const scid = Number.parseInt(socketName.slice("scrcpy_".length), 16);
  const args = [
    version,
    `scid=${scid.toString(16)}`,
    "video=true", "audio=false", "control=false",
    "tunnel_forward=true",
    "raw_stream=true",
    "send_dummy_byte=true", // after raw_stream; re-enables the handshake byte
    `max_size=${q.width ?? 540}`, `video_codec=${q.codec ?? "h265"}`,
    `video_bit_rate=${bitrateToInt(q.bitrate ?? "4M")}`, `max_fps=${q.fps ?? 60}`,
    ...(q.showTouches ? ["show_touches=true"] : []),
    ...(q.stayAwake ? ["stay_awake=true"] : []),
    ...(q.powerOffOnClose ? ["power_off_on_close=true"] : []),
    "log_level=warn",
  ];
  const cmd = `CLASSPATH=${jarRemote} app_process / com.genymobile.scrcpy.Server ${args.join(" ")}`;
  if (process.env.REX_SIM_DEBUG_CMD) console.error("video server:", cmd);
  const server = spawn(ADB, ["-s", serial, "shell", cmd], { stdio: "ignore" });
  let port = null;
  let socket = null;
  // Registered before any stage that can fail: forward failure, connect
  // timeout, or the server process erroring. On failure the spawned server
  // and the adb forward are torn down so nothing is orphaned. The forward
  // removal is intentionally outside the `cleaned` guard: cleanup may run
  // before the forward assigned a port (e.g. a spawn error), and the port
  // must still be removed if it is assigned later.
  let cleaned = false;
  let forwardRemoved = false;
  let removingForward = null;
  // Remove this session's adb forward. Success is recorded only when adb
  // confirms it; a transient failure keeps the mapping so close() can retry.
  // Concurrent removals share one in-flight attempt (no double-remove), and a
  // removed/resolved port is never touched again.
  const removeForward = () => {
    if (forwardRemoved || port == null) return Promise.resolve();
    if (removingForward) return removingForward;
    removingForward = run(ADB, ["-s", serial, "forward", "--remove", `tcp:${port}`])
      .then(() => { forwardRemoved = true; })
      .catch(() => {}) // keep the mapping for a later retry
      .finally(() => { removingForward = null; });
    return removingForward;
  };
  const cleanupStartup = () => {
    if (!cleaned) {
      cleaned = true;
      try { socket?.destroy(); } catch {}
      if (server.exitCode == null) {
        server.kill("SIGTERM");
        setTimeout(() => { if (server.exitCode == null) server.kill("SIGKILL"); }, 2000).unref();
      }
      // Also kill the remote server by its unique jar name, so no orphaned
      // on-device server outlives the pane.
      run(ADB, ["-s", serial, "shell", `pkill -f ${jarRemote}`]).catch(() => {});
    }
    removeForward();
  };
  server.on("error", () => cleanupStartup());
  try {
    const { stdout } = await run(ADB, ["-s", serial, "forward", "tcp:0", `localabstract:${socketName}`]);
    port = Number(stdout.trim());
    socket = await connectWithRetry(port, opts.connectTimeoutMs ?? 15000);
    // The tunnel is established. scrcpy's own server removes its forwarding
    // once the client connects; do the same now (awaiting success, but with a
    // retry available at close if adb is transiently unavailable), so a crash
    // mid-stream does not leave a listening adb forward behind.
    await removeForward();
  } catch (e) {
    cleanupStartup();
    throw e;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch {}
    cleanupStartup();
  };
  return { socket, close };
}

// Starts the control-only scrcpy server, forwards its socket, and resolves
// with a connected net.Socket.
export async function startControlSocket(serial) {
  const jar = serverJarPath();
  if (!jar) throw new Error("couldn't find scrcpy-server.jar (set REX_SIM_SCRCPY_SERVER)");
  const version = scrcpyVersion();
  if (!version) throw new Error("scrcpy not found");
  // The server unlinks its own jar on exit, so a shared path gets clobbered
  // between runs (ClassNotFoundException on the next launch). Use a unique
  // per-session jar, plus a unique socket name to avoid collisions with any
  // other scrcpy server (for example one the pane itself runs).
  const jarRemote = `/data/local/tmp/scrcpy-server-${process.pid}-${Math.floor(Math.random() * 0xffffff).toString(16)}.jar`;
  await run(ADB, ["-s", serial, "push", jar, jarRemote]);
  const socketName = randomSocketName();
  const scid = Number.parseInt(socketName.slice("scrcpy_".length), 16);
  const args = [
    version,
    `scid=${scid.toString(16)}`, // the server reads scid in base 16
    "video=false", "audio=false", "control=true",
    "tunnel_forward=true",
    "send_device_meta=false", "send_dummy_byte=true",
    "log_level=error",
  ];
  const server = spawn(ADB, ["-s", serial, "shell", `CLASSPATH=${jarRemote} app_process / com.genymobile.scrcpy.Server ${args.join(" ")}`], { stdio: "ignore" });
  let port = null;
  let socket = null;
  let cleaned = false;
  let forwardRemoved = false;
  let removingForward = null;
  const removeForward = () => {
    if (forwardRemoved || port == null) return Promise.resolve();
    if (removingForward) return removingForward;
    removingForward = run(ADB, ["-s", serial, "forward", "--remove", `tcp:${port}`])
      .then(() => { forwardRemoved = true; })
      .catch(() => {})
      .finally(() => { removingForward = null; });
    return removingForward;
  };
  const cleanupStartup = () => {
    if (!cleaned) {
      cleaned = true;
      try { socket?.destroy(); } catch {}
      if (server.exitCode == null) {
        server.kill("SIGTERM");
        setTimeout(() => { if (server.exitCode == null) server.kill("SIGKILL"); }, 2000).unref();
      }
      run(ADB, ["-s", serial, "shell", `pkill -f ${jarRemote}`]).catch(() => {});
    }
    removeForward();
  };
  server.on("error", () => cleanupStartup());
  try {
    const { stdout } = await run(ADB, ["-s", serial, "forward", "tcp:0", `localabstract:${socketName}`]);
    port = Number(stdout.trim());
    socket = await connectWithRetry(port, 15000);
    // The control tunnel is established; remove this session's own forward now
    // (awaiting success, retry at close), so crashes don't leak it.
    await removeForward();
  } catch (e) {
    cleanupStartup();
    throw e;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch {}
    cleanupStartup();
  };
  return { socket, close };
}

// The same input surface as AdbInput, over the control socket. Points are
// 0..1 fractions of the screen.
//
// Some OEMs (vivo/OriginOS among them) block the classic key event injection;
// scrcpy's recommended workaround is UHID virtual devices, so keys and the
// Home/volume buttons go through a UHID keyboard + consumer device created on
// the first use. Touches and scrolls still use the SDK event path.
export class ScrcpyInput {
  constructor(socket, size) {
    this.socket = socket;
    this.size = size;
    this.queue = Promise.resolve();
    this.held = new Set();     // HID modifier usages currently held
    this.pressed = new Set();  // HID keyboard usages currently down
    this.uhidId = null;
  }

  send(buf) {
    this.queue = this.queue.then(() => new Promise((resolve, reject) => {
      this.socket.write(buf, (e) => (e ? reject(e) : resolve()));
    })).catch(() => {});
    return this.queue;
  }

  px(p) {
    return [Math.round(p.x * (this.size.width - 1)), Math.round(p.y * (this.size.height - 1))];
  }

  ensureUhid() {
    if (this.uhidId != null) return Promise.resolve();
    this.uhidId = 1;
    return this.send(uhidCreateMsg(this.uhidId, 0x18d1, 0x0001, "rex-sim", UHID_DESCRIPTOR));
  }

  // The current keyboard report: modifiers byte + up to six keys.
  keyboardReport() {
    const data = Buffer.alloc(8);
    let mods = 0;
    for (const u of this.held) {
      if (u === 224) mods |= 0x01;      // ctrl
      else if (u === 225) mods |= 0x02; // shift
      else if (u === 226) mods |= 0x04; // alt
      else if (u === 227) mods |= 0x08; // meta
    }
    data[0] = mods;
    let i = 0;
    for (const u of this.pressed) {
      if (i >= 6) break;
      data[2 + i++] = u;
    }
    return uhidInputMsg(this.uhidId, data);
  }

  consumer(value) {
    const b = Buffer.from([3, value & 0xff, value >> 8]);
    return uhidInputMsg(this.uhidId, b);
  }

  touch(type, p) {
    const action = type === "begin" ? ACTION.DOWN : type === "end" ? ACTION.UP : ACTION.MOVE;
    const [x, y] = this.px(p);
    return this.send(touchMsg(action, 0, x, y, this.size.width, this.size.height));
  }

  key(type, usage) {
    if (MODIFIERS.has(usage)) {
      if (type === "down") this.held.add(usage);
      else this.held.delete(usage);
      return this.ensureUhid().then(() => this.send(this.keyboardReport()));
    }
    if (type === "down") this.pressed.add(usage);
    else this.pressed.delete(usage);
    return this.ensureUhid().then(() => this.send(this.keyboardReport()));
  }

  button(name) {
    const usage = CONSUMER.home;
    if (name !== "home") return;
    return this.ensureUhid()
      .then(() => this.send(this.consumer(usage)))
      .then(() => this.send(this.consumer(0)));
  }

  volume(direction) {
    const usage = direction === "up" ? CONSUMER.volumeUp : CONSUMER.volumeDown;
    return this.ensureUhid()
      .then(() => this.send(this.consumer(usage)))
      .then(() => this.send(this.consumer(0)));
  }

  scroll(dy, p) {
    const [x, y] = this.px(p);
    return this.send(scrollMsg(x, y, this.size.width, this.size.height, 0, -dy));
  }

  rotate() {
    return this.send(rotateMsg());
  }
}
