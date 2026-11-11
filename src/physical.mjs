// A real Android device (wired or wireless over adb) live in a Rex pane.
//
// The emulator path streams frames from the emulator's gRPC controller, which
// a physical device doesn't have. For a real device we run scrcpy headless
// (`--no-window --no-video-playback`) recording into a named pipe as
// Matroska, and ffmpeg decodes that into a JPEG-per-frame stream we serve
// exactly like the emulator's stream: multipart/x-mixed-replace
// PNGs/JPEGs over localhost. Input goes through `adb shell input`, the same
// way the emulator path does.
//
// Two producers feed ffmpeg: the raw video socket (default) and the
// Matroska-over-fifo pipeline (fallback, REX_SIM_PIPE=mkv, or when audio is
// enabled). Each producer owns its children, cleanup, parser and first-frame
// timer; a retired producer's events are harmless, so a stale raw socket can
// never kill the mkv fallback that replaced it.
import { execFile, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ADB, adb, AdbInput, AdbStreamInput } from "./adb-input.mjs";
import { imageDisplaySize, imageSize, multipartFrames } from "./frames.mjs";
import { rotateMsg, ScrcpyInput, startControlSocket } from "./scrcpy-control.mjs";

const run = promisify(execFile);
const scrCpyCmd = () => process.env.REX_SIM_SCRCPY || "scrcpy";
const ffmpegCmd = () => process.env.REX_SIM_FFMPEG || "ffmpeg";
const IDLE_MS = 3000;
// KEYCODE_WAKEUP (224) wakes the screen; unlike KEYCODE_POWER (26) it never
// toggles power, so it is safe to send on a screen that may already be on.
const WAKE_KEYEVENT = "224";
const WAKE_TIMEOUT_MS = 5000;
// No-frame backstops: raw gets a short window before falling back to mkv;
// mkv (including after a fallback) gets longer, then stops so the app can
// reconnect. A stream that has delivered frames is never stopped by silence.
const RAW_NO_FRAME_MS = 6000;
const MKV_NO_FRAME_MS = 20000;

// Quality knobs for the physical-device stream, as environment variables:
//   REX_SIM_WIDTH       stream width in pixels (240-1080, default 540)
//   REX_SIM_BITRATE    scrcpy video bit-rate (default 4M)
//   REX_SIM_FPS        maximum capture frame rate (10-120, default 60)
//   REX_SIM_JPEG_Q     ffmpeg MJPEG quality, 1 best - 31 worst (default 4)
//   REX_SIM_CODEC      h265 (default, smaller on wifi) or h264
//   REX_SIM_SHOW_TOUCHES 1 to show touch feedback on the device
//   REX_SIM_STAY_AWAKE  1 to keep the device awake while streaming
//   REX_SIM_AUDIO  1 to forward device audio (uses the mkv pipeline)
//   REX_SIM_AUDIO_SOURCE  output (default), playback, mic, …
//   REX_SIM_AUDIO_CODEC  opus (default), aac, flac (raw unsupported)
//   REX_SIM_POWER_OFF_ON_CLOSE  1 to turn the screen off when the pane closes
const clampInt = (v, fallback, [min, max]) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
export function qualityConfig(env = process.env) {
  const codec = env.REX_SIM_CODEC === "h264" ? "h264" : "h265";
  const bool = (v) => v === "1" || v === true;
  return {
    width: clampInt(env.REX_SIM_WIDTH, 540, [240, 1080]),
    bitrate: env.REX_SIM_BITRATE || "4M",
    fps: clampInt(env.REX_SIM_FPS, 60, [10, 120]),
    jpegQ: clampInt(env.REX_SIM_JPEG_Q, 4, [1, 31]),
    codec,
    showTouches: bool(env.REX_SIM_SHOW_TOUCHES),
    stayAwake: bool(env.REX_SIM_STAY_AWAKE),
    audio: bool(env.REX_SIM_AUDIO),
    audioSource: env.REX_SIM_AUDIO_SOURCE || "output",
    audioCodec: env.REX_SIM_AUDIO_CODEC || "opus",
    powerOffOnClose: bool(env.REX_SIM_POWER_OFF_ON_CLOSE),
  };
}

// scrcpy headless-recording args for the mkv producer. Audio is routed
// through this pipeline using scrcpy's own native playback (`--no-video-playback`
// leaves audio playback on; `--no-playback` would silence it too); the raw
// video socket remains video-only, so audio selects the mkv pipeline.
// showTouches/stayAwake/powerOffOnClose are server options the CLI rejects
// together with --no-control, so those request a control channel with every
// input/clipboard facility disabled (headless control is used only to carry
// the server options).
export function scrcpyArgs(q, record, serial, portRange) {
  const args = [
    "--no-window", "--no-video-playback",
    `--video-codec=${q.codec}`,
    `--max-size=${q.width}`,
    `--video-bit-rate=${q.bitrate}`,
    `--max-fps=${q.fps}`,
    `--record=${record}`, "--record-format=mkv",
  ];
  if (portRange) args.push(`--port=${portRange.start}:${portRange.end}`);
  if (q.audio) {
    args.push(`--audio-source=${q.audioSource}`, `--audio-codec=${q.audioCodec}`);
  } else {
    args.push("--no-audio");
  }
  if (q.showTouches || q.stayAwake || q.powerOffOnClose) {
    args.push("--keyboard=disabled", "--mouse=disabled", "--gamepad=disabled", "--no-clipboard-autosync");
    if (q.showTouches) args.push("--show-touches");
    if (q.stayAwake) args.push("--stay-awake");
    if (q.powerOffOnClose) args.push("--power-off-on-close");
  } else {
    args.push("--no-control");
  }
  args.push("-s", serial);
  return args;
}

// ffmpeg args for both producers: always map exactly the first video stream,
// silence audio/subtitles, emit MJPEG with timestamps passed through (no
// duplicated/padded frames) and a fine encoder time base (coarse encoder
// timestamps produce nonmonotonic-DTS warnings on real captured streams).
// `input` is the demuxer/-i part (raw bitstream or mkv fifo).
// -analyzeduration 1 (µs) with -fpsprobesize 0 keeps analysis automatic but
// short: analyzeduration 0 made live first frames arrive ~7s late, while 1
// with the default probesize gives ~1s first frames (verified live on raw
// HEVC). -fpsprobesize 0 disables fps probing (keeps probesize 32768).
// Choose an available loopback port for scrcpy's adb tunnel. scrcpy 3.3.4
// records --port=0 verbatim (never getockname), so 0 is not viable; a real
// free port with a bounded retry range keeps native retries local without
// evicting other listeners on the shared default port (27183).
export async function allocateLoopbackRange(count = 17) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const start = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return { start, end: Math.min(start + count - 1, 65535) };
}

export function ffmpegArgs(q, input) {
  return [
    "-loglevel", "error", "-nostdin",
    "-flags", "low_delay", "-analyzeduration", "1", "-probesize", "32768",
    "-fpsprobesize", "0",
    ...input,
    "-map", "0:v:0",
    "-an", "-sn",
    "-c:v", "mjpeg", "-q:v", String(q.jpegQ),
    // Single-threaded MJPEG encoding keeps per-frame SAR (rotation) metadata
    // ordered: threaded encoding can let a changed global encoder SAR apply to
    // already-queued frames of the later orientation.
    "-threads:v", "1",
    "-fps_mode", "passthrough",
    "-enc_time_base:v", "1:1000000",
    "-f", "image2pipe", "-",
  ];
}

let toolsChecked = null;
function toolsAvailable() {
  if (toolsChecked === null) {
    const r = spawnSync("sh", ["-c", `command -v "${scrCpyCmd()}" >/dev/null && command -v "${ffmpegCmd()}" >/dev/null`]);
    toolsChecked = r.status === 0;
  }
  return toolsChecked;
}

// `adb devices` output -> physical Android devices. Emulator serials are left
// to the android platform; anything else with a state counts. The state is
// always the last whitespace-delimited token; serials themselves may contain
// spaces (adb's mDNS disambiguation appends " (2)" for duplicate service
// instances), so only the trailing token is read as the state.
export function parseDevices(stdout) {
  const devices = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue; // empty lines
    const state = parts[parts.length - 1];
    const serial = parts.slice(0, -1).join(" ");
    if (serial === "List of devices") continue; // header line
    if (serial.startsWith("emulator-")) continue;
    let unusable = null;
    if (state === "unauthorized") unusable = "authorize this computer on the phone (USB debugging prompt)";
    else if (state === "offline") unusable = "offline";
    else if (state !== "device") unusable = `state: ${state}`;
    devices.push({ platform: "android-physical", id: serial, serial, name: serial, os: "Android", booted: false, unusable });
  }
  return devices;
}

const PLACEHOLDER_ID = /^(unknown|null|0|none)$/i;
// A hardware identity we are willing to group transports by: a nonempty,
// non-placeholder serial from the device itself. Never model/IP/name.
export function stableHardwareId(id) {
  if (!id) return null;
  const t = String(id).trim();
  return t && !PLACEHOLDER_ID.test(t) ? t : null;
}

// Deterministic transport preference for the same physical device: USB first,
// then mDNS, then TCP.
export function transportRank(serial) {
  if (serial.includes(":")) return 2;
  if (serial.startsWith("adb-") && serial.includes("._adb-tls-connect.")) return 1;
  return 0;
}

// One phone reachable over two adb transports (USB + mDNS/TCP) lists twice;
// group by the device's hardware id. The chosen entry keeps its own id/serial
// and records the other transports as aliases so saved choices and --device
// lookups keep resolving. Entries without a stable hardware id are never
// merged; unusable/unknown entries stay separate.
export function deduplicatePhysicalDevices(devices) {
  const groups = new Map();
  for (const d of devices) {
    const key = stableHardwareId(d.hardwareId);
    if (!key) {
      groups.set(d, { members: [d] }); // unique key, kept as-is
      continue;
    }
    let g = groups.get(key);
    if (!g) {
      g = { members: [] };
      groups.set(key, g);
    }
    g.members.push(d);
  }
  const out = [];
  for (const g of groups.values()) {
    const members = g.members;
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    const primary = [...members].sort((a, b) => {
      const au = a.unusable ? 1 : 0;
      const bu = b.unusable ? 1 : 0;
      if (au !== bu) return au - bu;
      return transportRank(a.serial) - transportRank(b.serial);
    })[0];
    const aliases = members.filter((m) => m !== primary).map((m) => m.serial);
    if (aliases.length) primary.aliases = [...(primary.aliases ?? []), ...aliases];
    out.push(primary);
  }
  return out;
}

export async function listPhysicalDevices() {
  const { stdout } = await run(ADB, ["devices"]);
  const devices = parseDevices(stdout);
  if (devices.length && !toolsAvailable()) {
    for (const d of devices) d.unusable = "needs scrcpy and ffmpeg (brew install scrcpy ffmpeg)";
    return devices;
  }
  await Promise.all(devices.map(async (d) => {
    if (d.unusable) return;
    try {
      const { stdout: props } = await adb(d.serial, ["shell", "getprop ro.product.model; getprop ro.build.version.release; getprop sys.boot_completed; getprop ro.serialno; getprop ro.boot.serialno"]);
      const [model, release, booted, serialno, bootSerialno] = props.trim().split("\n").map((s) => s.trim());
      d.name = model || d.serial;
      d.os = release ? `Android ${release}` : "Android";
      d.booted = booted === "1";
      d.hardwareId = stableHardwareId(serialno) ?? stableHardwareId(bootSerialno);
    } catch {}
  }));
  return deduplicatePhysicalDevices(devices);
}

// A device that isn't in `adb devices` yet: wireless serials (ip:port) get an
// `adb connect`. Wired devices are already there.
export async function connectPhysicalDevice(device) {
  if (device.serial.includes(":")) await run(ADB, ["connect", device.serial]);
}

// `wm size` may report both an override and the physical size; the override
// wins when present.
export function parseEffectiveWmSize(stdout) {
  const lines = stdout.split("\n").map((s) => s.trim());
  const find = (kind) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(`${kind} size:`));
    if (!line) return null;
    const m = /(\d+)x(\d+)/.exec(line);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return find("override") ?? find("physical") ?? { width: 1080, height: 2220 };
}

// The device's logical touch extents for a given display orientation: adb and
// scrcpy input coordinates are screen fractions, so the extents must follow
// rotation. `base` is the WM (effective) size; the longer side is horizontal
// in landscape, vertical in portrait.
export function touchExtents(base, display) {
  const landscape = display.width > display.height;
  const w = landscape ? Math.max(base.width, base.height) : Math.min(base.width, base.height);
  const h = landscape ? Math.min(base.width, base.height) : Math.max(base.width, base.height);
  return { width: w, height: h };
}

// The physical frame iterator: yields the multipart frames and keeps the
// input's touch extents in step with the current frame's DISPLAY size (JFIF
// pixel aspect honored), so landscape sessions map correctly.
export async function* physicalFrames(url, signal, input, baseSize) {
  for await (const bytes of multipartFrames(url, signal)) {
    const display = imageDisplaySize(bytes) ?? imageSize(bytes);
    if (display && input) input.size = touchExtents(baseSize, display);
    yield bytes;
  }
}

// Lazy, reusable, per-session native scrcpy rotation control. The control
// socket is opened on first use; if it is unavailable or a write fails while
// live (some OEMs block the control channel), the caller's fallback (adb
// rotation) is used. After close() or when close races a pending open, no
// device action happens at all (quiet cancellation). Runtime socket errors
// are consumed and invalidate the cached socket so a later rotate reopens.
export class RotateControl {
  constructor(serial, opts = {}) {
    this.serial = serial;
    this.provider = opts.provider ?? startControlSocket;
    this.warn = opts.warn ?? ((msg) => console.warn(msg));
    this.state = "idle"; // idle | opening | ready | closed
    this.opening = null;
    this.socket = null;
    this.closeSocket = null;
    this.onSocketError = null;
    this.onSocketClose = null;
  }

  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    this._detachSocket();
  }

  _detachSocket() {
    const socket = this.socket;
    const closeSocket = this.closeSocket;
    this.socket = null;
    this.closeSocket = null;
    if (socket) {
      socket.off("error", this.onSocketError);
      socket.off("close", this.onSocketClose);
      try { socket.destroy(); } catch {}
    }
    closeSocket?.();
  }

  _open() {
    if (this.state === "ready") return Promise.resolve(this.socket);
    if (this.state === "closed") return Promise.reject(new Error("rotate control closed"));
    if (this.opening) return this.opening;
    this.state = "opening";
    this.opening = this.provider(this.serial)
      .then(({ socket, close }) => {
        if (this.state === "closed") {
          try { socket.destroy(); } catch {}
          close();
          throw new Error("rotate control closed");
        }
        this.socket = socket;
        this.closeSocket = close;
        this.onSocketError = () => {
          if (this.state === "ready") {
            this.state = "idle";
            this._detachSocket();
          }
        };
        this.onSocketClose = () => {
          if (this.state === "ready") {
            this.state = "idle";
            this._detachSocket();
          }
        };
        socket.on("error", this.onSocketError);
        socket.on("close", this.onSocketClose);
        this.state = "ready";
        return socket;
      })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  // Direct ROTATE_DEVICE write; unlike ScrcpyInput.send this surfaces write
  // failures so the fallback actually runs when the write fails.
  _sendRotate(socket) {
    return new Promise((resolve, reject) => {
      socket.write(rotateMsg(), (err) => (err ? reject(err) : resolve()));
    });
  }

  async rotate(fallback) {
    if (this.state === "closed") return; // quiet cancellation after close
    let socket;
    try {
      socket = await this._open();
      if (this.state !== "ready") return; // raced: closed/invalidated meanwhile
      await this._sendRotate(socket);
    } catch (e) {
      if (this.state === "closed") return; // close raced a pending open
      this.warn(`scrcpy rotation unavailable (${e.message}); using adb rotation`);
      try {
        await fallback();
      } catch (fbErr) {
        this.warn(`adb rotation failed: ${fbErr.message}`);
      }
    }
  }
}

// `input keyevent 224` (KEYCODE_WAKEUP) wakes the screen; a locked phone shows
// its lock screen. Best-effort and bounded: a hung adb fails quietly.
export async function wakePhysicalDevice(serial, opts = {}) {
  const runner = opts.run ?? run;
  try {
    await runner(ADB, ["-s", serial, "shell", "input", "keyevent", WAKE_KEYEVENT], {
      timeout: opts.timeout ?? WAKE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// The session's wake action: refuses to act once the session is closed
// (ended), so a late focus edge after close can never touch the phone.
export function physicalWake(serial, { isClosed = () => false, run: runner = run } = {}) {
  return () => (isClosed() ? Promise.resolve(false) : wakePhysicalDevice(serial, { run: runner }));
}

export async function startPhysicalDevice(device) {
  const serial = device.serial;
  await adb(serial, ["shell", "input", "keyevent", "224"]).catch(() => {});
  const size = parseEffectiveWmSize((await adb(serial, ["shell", "wm", "size"])).stdout);
  const abort = new AbortController();
  let ended = false;
  const stream = await startStream(serial, { signal: abort.signal });
  const rotateControl = new RotateControl(serial);
  let input;
  let nativeInput = false;
  try {
    // A persistent adb shell is the reliable default (fast, no per-event
    // process). REX_SIM_ADB_SPAWN=1 restores one adb spawn per event;
    // REX_SIM_INPUT=control opts into the scrcpy control channel (fastest, but
    // some OEMs like vivo/OriginOS block it until 'USB debugging (Security
    // settings)' is enabled in developer options).
    if (process.env.REX_SIM_INPUT === "control") {
      try {
        const { socket, close: closeControl } = await startControlSocket(serial);
        input = new ScrcpyInput(socket, size);
        input.close = closeControl;
        nativeInput = true;
      } catch (e) {
        console.error(`scrcpy control unavailable (${e.message}); using adb input`);
      }
    }
    input ??= process.env.REX_SIM_ADB_SPAWN === "1" ? new AdbInput(serial, size) : new AdbStreamInput(serial, size);
    if (!nativeInput) {
      // Native rotate for ADB inputs (including when the control channel
      // failed), with adb rotation as the explicit fallback.
      const adbRotate = input.rotate.bind(input);
      input.rotate = () => rotateControl.rotate(() => adbRotate());
    }
  } catch (e) {
    stream.close(); // input setup failed: close the stream we already acquired
    throw e;
  }
  return {
    device,
    frames: physicalFrames(`http://127.0.0.1:${stream.port}/stream`, abort.signal, input, size),
    input,
    wake: physicalWake(serial, { isClosed: () => ended }),
    close: () => {
      ended = true;
      abort.abort();
      stream.close();
      rotateControl.close();
      input.close?.();
    },
  };
}

// JPEG frames from a byte stream, as ffmpeg's image2pipe produces them. A
// JPEG is FFD8 … FFD9; encoder byte-stuffing keeps real FFD9 bytes out of the
// scan data, so scanning for the markers is reliable.
export class MjpegParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.SOI = Buffer.from([0xff, 0xd8]);
    this.EOI = Buffer.from([0xff, 0xd9]);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
  }

  // Every complete frame currently buffered, leaving the rest for later.
  next() {
    const frames = [];
    for (;;) {
      const s = this.buf.indexOf(this.SOI);
      if (s < 0) {
        // Drop garbage, but keep a byte so a marker split across chunks isn't missed.
        this.buf = this.buf.length ? this.buf.subarray(this.buf.length - 1) : this.buf;
        return frames;
      }
      if (s > 0) this.buf = this.buf.subarray(s);
      const e = this.buf.indexOf(this.EOI, 2);
      if (e < 0) {
        // A corrupt stream without an end marker: drop the head and keep scanning.
        if (this.buf.length > 16 * 1024 * 1024) this.buf = this.buf.subarray(this.buf.length - 4096);
        return frames;
      }
      frames.push(this.buf.subarray(0, e + 2));
      this.buf = this.buf.subarray(e + 2);
    }
  }
}

// Test seam: the raw producer dials the scrcpy video server through this
// provider. Defaults to the real implementation; tests substitute a fake.
let videoSocketProvider = () => import("./scrcpy-control.mjs");
export function _setVideoSocketProvider(fn) {
  videoSocketProvider = fn;
}

// Per-viewer delivery: one complete multipart frame per write. A slow viewer
// gets at most one queued frame at a time and only catches up to the newest
// frame once its socket drains. The revision is recorded when the frame is
// handed to the write queue, so a frame larger than the writable high-water
// mark is never resent on drain — that would duplicate it forever.
// The latest source frame lives on the sink (updateLatest), not in captured
// closure values, so a drain always catches up to frames that arrived while
// the viewer was stalled.
export class ViewerSink {
  constructor() {
    this.stalled = new Set();
    this.sent = new Map(); // res -> revision of the last frame handed to it
    this.latest = null;
    this.latestRev = 0;
  }

  updateLatest(jpeg, rev) {
    this.latest = jpeg;
    this.latestRev = rev;
  }

  send(res, jpeg, rev) {
    if (res.destroyed) return;
    if (this.stalled.has(res)) return; // skipped; drain will read fresh latest
    const frame = Buffer.concat([
      Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
      jpeg,
      Buffer.from("\r\n"),
    ]);
    this.sent.set(res, rev);
    if (!res.write(frame)) {
      this.stalled.add(res);
      res.once("drain", () => {
        this.stalled.delete(res);
        if (!res.destroyed && this.latest && this.latestRev > (this.sent.get(res) ?? -1)) {
          this.send(res, this.latest, this.latestRev);
        }
      });
    }
  }

  drop(res) {
    this.stalled.delete(res);
    this.sent.delete(res);
  }

  clear() {
    this.stalled.clear();
    this.sent.clear();
  }
}

// Runs scrcpy | ffmpeg for a serial, and serves its frames the way the
// emulator's stream helper does: multipart on a localhost port, with the
// latest frame sent to a new viewer right away.
export async function startStream(serial, opts = {}) {
  if (!toolsAvailable()) throw new Error("needs scrcpy and ffmpeg (brew install scrcpy ffmpeg)");
  const q = qualityConfig();
  const rawNoFrameMs = opts.rawTimeoutMs ?? RAW_NO_FRAME_MS;
  const mkvNoFrameMs = opts.mkvTimeoutMs ?? MKV_NO_FRAME_MS;
  const sig = opts.signal;
  const abortStop = () => stop();
  // Pre-aborted signal: don't start any producer at all.
  if (sig?.aborted) throw new Error("stream closed while starting");

  const viewers = new Set();
  const sink = new ViewerSink();
  let last = null;
  let lastRev = 0;
  let rev = 0;
  let idle = null;
  let stopped = false;
  let current = null; // the owning producer
  let generation = 0;
  let fellBack = false;

  const send = (res, jpeg, frameRev) => sink.send(res, jpeg, frameRev);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store" });
    viewers.add(res);
    if (last) send(res, last, lastRev);
    clearTimeout(idle);
    idle = null;
    res.on("close", () => {
      viewers.delete(res);
      sink.drop(res);
      if (!viewers.size) idle ??= setTimeout(stop, IDLE_MS);
    });
  });

  // A producer owns its children, cleanup, parser, first-frame timer and
  // sawFrame. Retiring it invalidates it up front, so any event from a
  // replaced producer is harmless.
  function createProducer(mode) {
    return {
      mode,
      id: ++generation,
      children: [],
      cleanups: [],
      parser: new MjpegParser(),
      firstFrameTimer: null,
      sawFrame: false,
      ffmpeg: null,
      scrcpy: null,
      retired: false,
    };
  }

  function isCurrent(p) {
    return current === p && !p.retired;
  }

  function retire(p) {
    if (!p) return;
    const first = !p.retired;
    p.retired = true;
    if (current === p) current = null;
    clearTimeout(p.firstFrameTimer);
    p.firstFrameTimer = null;
    if (first) {
      for (const child of p.children) {
        if (child.exitCode != null) continue;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null) child.kill("SIGKILL");
        }, 2000).unref();
      }
      p.children.length = 0;
    }
    // Always drain pending cleanups, even on a second retire: a producer that
    // started (or finished dialing) after its first retirement may have
    // registered new cleanups that must still run.
    for (const cleanup of p.cleanups.splice(0)) {
      try { cleanup(); } catch {}
    }
  }

  // Runs on every call: server.close() is idempotent, so a stop that lands
  // while listen() is still pending still closes the server once it has
  // bound, and a post-listen cancellation really closes it.
  const stop = () => {
    stopped = true;
    sig?.removeEventListener("abort", abortStop);
    retire(current);
    clearTimeout(idle);
    server.close();
    for (const res of viewers) res.destroy();
    viewers.clear();
    sink.clear();
  };

  // Attach the producer's event handlers. Every handler captures this
  // producer; retired producers are ignored. A hard exit ends an established
  // session, but a producer that never delivered a frame falls back (raw)
  // or stops (mkv) after its no-frame window.
  function watch(p, ffmpeg) {
    p.children.push(ffmpeg);
    p.ffmpeg = ffmpeg;
    ffmpeg.on("error", () => {}); // register immediately; dead() decides
    const dead = () => {
      if (!isCurrent(p)) return;
      if (p.sawFrame) return stop();
      if (p.mode === "raw") fallbackToMkv();
      else stop();
    };
    ffmpeg.stdout.on("data", (chunk) => {
      if (!isCurrent(p)) return;
      p.parser.push(chunk);
      for (const jpeg of p.parser.next()) {
        if (!isCurrent(p)) return;
        if (!p.sawFrame) {
          p.sawFrame = true;
          clearTimeout(p.firstFrameTimer);
          p.firstFrameTimer = null;
        }
        last = jpeg;
        lastRev = ++rev;
        sink.updateLatest(last, lastRev);
        for (const res of viewers) send(res, last, lastRev);
      }
    });
    ffmpeg.on("exit", dead);
    ffmpeg.on("error", dead);
    if (ffmpeg.stdin) ffmpeg.stdin.on("error", () => {}); // EPIPE after teardown
    if (p.scrcpy) {
      p.scrcpy.on("exit", dead);
      p.scrcpy.on("error", dead);
    }
    p.firstFrameTimer = setTimeout(() => {
      if (!isCurrent(p) || p.sawFrame) return;
      dead();
    }, p.mode === "raw" ? rawNoFrameMs : mkvNoFrameMs);
    p.dead = dead;
    return dead;
  }

  // Preferred: talk to our own video-only scrcpy server and feed its raw
  // bitstream to ffmpeg on stdin. No container, no fifo.
  async function startRaw(p) {
    if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    const { startVideoSocket } = await videoSocketProvider();
    const { socket, close } = await startVideoSocket(serial, q);
    p.cleanups.push(close);
    p.socket = socket;
    if (stopped || sig?.aborted) throw new Error("stream closed while starting"); // before spawning ffmpeg
    const ffmpeg = spawn(ffmpegCmd(), ffmpegArgs(q, ["-f", q.codec === "h265" ? "hevc" : "h264", "-i", "pipe:0"]), { stdio: ["pipe", "pipe", "inherit"] });
    ffmpeg.on("error", () => {});
    ffmpeg.stdin.on("error", () => {});
    socket.pipe(ffmpeg.stdin);
    socket.on("error", () => p.dead?.());
    socket.on("close", () => {
      try { ffmpeg.stdin.end(); } catch {}
    });
    watch(p, ffmpeg);
  }

  // Fallback: the original scrcpy client recording Matroska into a fifo.
  // Each producer gets its own temp directory, so a retired producer's
  // cleanup can never unlink a live successor's fifo.
  async function startMkv(p) {
    if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    const dir = mkdtempSync(join(tmpdir(), "rex-sim-"));
    const fifo = join(dir, "stream.mkv");
    p.cleanups.push(() => rmSync(dir, { recursive: true, force: true })); // before anything can fail
    if (spawnSync("sh", ["-c", `mkfifo "${fifo}"`]).status !== 0) {
      throw new Error("couldn't create a pipe for the phone's stream");
    }
    if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    const range = await allocateLoopbackRange();
    if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    const scrcpy = spawn(scrCpyCmd(), scrcpyArgs(q, fifo, serial, range), { stdio: ["ignore", "ignore", "inherit"] });
    scrcpy.on("error", () => {});
    p.children.push(scrcpy);
    p.scrcpy = scrcpy;
    const ffmpeg = spawn(ffmpegCmd(), ffmpegArgs(q, ["-f", "matroska", "-i", fifo]), { stdio: ["ignore", "pipe", "inherit"] });
    ffmpeg.on("error", () => {});
    watch(p, ffmpeg);
  }

  // Switch producers once: invalidate the outgoing producer before any
  // cleanup or awaiting the replacement, so its late events are harmless and
  // never watch the new one.
  async function fallbackToMkv() {
    if (fellBack || stopped) return;
    fellBack = true;
    retire(current);
    try {
      await startProducer("mkv");
    } catch {
      if (!stopped) stop();
    }
  }

  // Activate ownership before any child/handler/pipe is attached; a close or
  // abort during startup throws and the outer catch cleans the late result.
  async function startProducer(mode) {
    if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    const p = createProducer(mode);
    current = p;
    try {
      if (mode === "raw") await startRaw(p);
      else await startMkv(p);
      if (stopped || sig?.aborted) throw new Error("stream closed while starting");
    } catch (e) {
      retire(p);
      throw e;
    }
  }

  sig?.addEventListener("abort", abortStop);
  try {
    if (q.audio || process.env.REX_SIM_PIPE === "mkv") {
      await startProducer("mkv");
    } else {
      try {
        await startProducer("raw");
      } catch (e) {
        if (stopped || sig?.aborted) throw e;
        console.error(`raw video unavailable (${e.message}); falling back to mkv pipe`);
        await startProducer("mkv");
      }
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (stopped || sig?.aborted) {
      stop(); // never hand out a live listening server after a stop
      throw new Error("stream closed while starting");
    }
  } catch (e) {
    retire(current);
    stop();
    throw e;
  }

  return { port: server.address().port, close: stop };
}
