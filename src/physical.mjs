// A real Android device (wired or wireless over adb) live in a Rex pane.
//
// The emulator path streams frames from the emulator's gRPC controller, which
// a physical device doesn't have. For a real device we run scrcpy headless
// (`--no-playback --no-window`) recording into a named pipe as Matroska, and
// ffmpeg decodes that into a JPEG-per-frame stream we serve exactly like the
// emulator's stream: multipart/x-mixed-replace PNGs/JPEGs over localhost.
// Input goes through `adb shell input`, the same way the emulator path does.
import { execFile, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { ADB, adb, AdbInput, AdbStreamInput } from "./adb-input.mjs";
import { multipartFrames } from "./frames.mjs";
import { ScrcpyInput, startControlSocket } from "./scrcpy-control.mjs";

const run = promisify(execFile);
const SCRCPY = process.env.REX_SIM_SCRCPY || "scrcpy";
const FFMPEG = process.env.REX_SIM_FFMPEG || "ffmpeg";
const IDLE_MS = 3000;

// Quality knobs for the physical-device stream, as environment variables:
//   REX_SIM_WIDTH       stream width in pixels (240-1080, default 540)
//   REX_SIM_BITRATE    scrcpy video bit-rate (default 4M)
//   REX_SIM_FPS        maximum capture frame rate (10-120, default 60)
//   REX_SIM_JPEG_Q     ffmpeg MJPEG quality, 1 best - 31 worst (default 4)
//   REX_SIM_CODEC      h265 (default, smaller on wifi) or h264
const clampInt = (v, fallback, [min, max]) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
export function qualityConfig(env = process.env) {
  const codec = env.REX_SIM_CODEC === "h264" ? "h264" : "h265";
  return {
    width: clampInt(env.REX_SIM_WIDTH, 540, [240, 1080]),
    bitrate: env.REX_SIM_BITRATE || "4M",
    fps: clampInt(env.REX_SIM_FPS, 60, [10, 120]),
    jpegQ: clampInt(env.REX_SIM_JPEG_Q, 4, [1, 31]),
    codec,
  };
}

let toolsChecked = null;
function toolsAvailable() {
  if (toolsChecked === null) {
    const r = spawnSync("sh", ["-c", `command -v "${SCRCPY}" >/dev/null && command -v "${FFMPEG}" >/dev/null`]);
    toolsChecked = r.status === 0;
  }
  return toolsChecked;
}

// `adb devices` output -> physical Android devices. Emulator serials are left
// to the android platform; anything else with a state counts.
export function parseDevices(stdout) {
  const devices = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue; // the header line and empty lines
    const [serial, state] = parts;
    if (serial.startsWith("emulator-")) continue;
    let unusable = null;
    if (state === "unauthorized") unusable = "authorize this computer on the phone (USB debugging prompt)";
    else if (state === "offline") unusable = "offline";
    else if (state !== "device") unusable = `state: ${state}`;
    devices.push({ platform: "android-physical", id: serial, serial, name: serial, os: "Android", booted: false, unusable });
  }
  return devices;
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
      const { stdout: props } = await adb(d.serial, ["shell", "getprop ro.product.model; getprop ro.build.version.release; getprop sys.boot_completed"]);
      const [model, release, booted] = props.trim().split("\n").map((s) => s.trim());
      d.name = model || d.serial;
      d.os = release ? `Android ${release}` : "Android";
      d.booted = booted === "1";
    } catch {}
  }));
  return devices;
}

// A device that isn't in `adb devices` yet: wireless serials (ip:port) get an
// `adb connect`. Wired devices are already there.
export async function connectPhysicalDevice(device) {
  if (device.serial.includes(":")) await run(ADB, ["connect", device.serial]);
}

// `input keyevent 224` wakes the screen; a locked phone shows its lock screen.
export async function startPhysicalDevice(device) {
  const serial = device.serial;
  await adb(serial, ["shell", "input", "keyevent", "224"]).catch(() => {});
  const m = /(\d+)x(\d+)/.exec((await adb(serial, ["shell", "wm", "size"])).stdout);
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2220 };
  const abort = new AbortController();
  const { port, close } = await startStream(serial);
  // A persistent adb shell is the reliable default (fast, no per-event
  // process). REX_SIM_ADB_SPAWN=1 restores one adb spawn per event;
  // REX_SIM_INPUT=control opts into the scrcpy control channel (fastest, but
  // some OEMs like vivo/OriginOS block it until 'USB debugging (Security
  // settings)' is enabled in developer options).
  let input;
  if (process.env.REX_SIM_INPUT === "control") {
    try {
      const { socket, close: closeControl } = await startControlSocket(serial);
      input = new ScrcpyInput(socket, size);
      input.close = closeControl;
    } catch (e) {
      console.error(`scrcpy control unavailable (${e.message}); using adb input`);
    }
  }
  input ??= process.env.REX_SIM_ADB_SPAWN === "1" ? new AdbInput(serial, size) : new AdbStreamInput(serial, size);
  return {
    device,
    frames: multipartFrames(`http://127.0.0.1:${port}/stream`, abort.signal),
    input,
    close: () => {
      abort.abort();
      close();
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

// Runs scrcpy | ffmpeg for a serial, and serves its frames the way the
// emulator's stream helper does: multipart on a localhost port, with the
// latest frame sent to a new viewer right away.
//
// Two producers feed ffmpeg: the raw video socket (default) and the
// Matroska-over-fifo pipeline (fallback, REX_SIM_PIPE=mkv).
async function startStream(serial) {
  if (!toolsAvailable()) throw new Error("needs scrcpy and ffmpeg (brew install scrcpy ffmpeg)");
  const q = qualityConfig();

  const viewers = new Set();
  let last = null;
  let idle = null;
  let stopped = false;
  let firstFrameTimer = null;
  const children = [];
  const cleanups = [];

  function send(res, jpeg) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store" });
    viewers.add(res);
    if (last) send(res, last);
    clearTimeout(idle);
    idle = null;
    res.on("close", () => {
      viewers.delete(res);
      if (!viewers.size) idle ??= setTimeout(stop, IDLE_MS);
    });
  });

  const killChildren = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(idle);
    for (const child of children) {
      if (child.exitCode != null) continue;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 2000).unref();
    }
    for (const cleanup of cleanups) {
      try { cleanup(); } catch {}
    }
  };
  const stop = () => {
    clearTimeout(firstFrameTimer);
    killChildren();
    server.close();
    for (const res of viewers) res.destroy();
    viewers.clear();
  };

  const parser = new MjpegParser();
  let sawFrame = false;
  const watch = (ffmpeg) => {
    children.push(ffmpeg);
    ffmpeg.stdout.on("data", (chunk) => {
      parser.push(chunk);
      for (const jpeg of parser.next()) {
        sawFrame = true;
        last = jpeg;
        for (const res of viewers) send(res, last);
      }
    });
    ffmpeg.on("exit", stop);
    ffmpeg.on("error", stop);
    // A phone with an idle screen may not send any frame; don't hang the pane.
    firstFrameTimer = setTimeout(() => { if (!sawFrame) stop(); }, 20000);
  };

  // Preferred: talk to our own video-only scrcpy server and feed its raw
  // bitstream to ffmpeg on stdin. No container, no fifo.
  async function startRaw() {
    const { startVideoSocket } = await import("./scrcpy-control.mjs");
    const { socket, close } = await startVideoSocket(serial, q);
    const ffmpeg = spawn(FFMPEG, [
      "-loglevel", "error", "-nostdin",
      "-flags", "low_delay", "-analyzeduration", "0", "-probesize", "32768",
      "-f", q.codec === "h265" ? "hevc" : "h264", "-i", "pipe:0",
      "-an", "-sn",
      "-c:v", "mjpeg", "-q:v", String(q.jpegQ),
      "-f", "image2pipe", "-",
    ], { stdio: ["pipe", "pipe", "inherit"] });
    socket.pipe(ffmpeg.stdin);
    socket.on("error", stop);
    socket.on("close", () => { try { ffmpeg.stdin.end(); } catch {} });
    cleanups.push(close);
    return ffmpeg;
  }

  // Fallback: the original scrcpy client recording Matroska into a fifo.
  async function startMkv() {
    const fifo = `${tmpdir()}/rex-sim-${process.pid}-${serial.replace(/[^A-Za-z0-9]/g, "_")}.mkv`;
    rmSync(fifo, { force: true });
    if (spawnSync("sh", ["-c", `mkfifo "${fifo}"`]).status !== 0) {
      throw new Error("couldn't create a pipe for the phone's stream");
    }
    const scrcpy = spawn(SCRCPY, [
      "--no-playback", "--no-window", "--no-audio", "--no-control",
      `--video-codec=${q.codec}`, `--max-size=${q.width}`,
      `--video-bit-rate=${q.bitrate}`, `--max-fps=${q.fps}`,
      `--record=${fifo}`, "--record-format=mkv", "-s", serial,
    ]);
    children.push(scrcpy);
    scrcpy.on("exit", stop);
    scrcpy.on("error", stop);
    cleanups.push(() => rmSync(fifo, { force: true }));
    const ffmpeg = spawn(FFMPEG, [
      "-loglevel", "error", "-nostdin",
      // -fflags nobuffer starves the matroska-over-fifo demuxer; keep the
      // other low-latency flags instead.
      "-flags", "low_delay", "-analyzeduration", "0", "-probesize", "32768",
      "-f", "matroska", "-i", fifo,
      "-an", "-sn",
      "-c:v", "mjpeg", "-q:v", String(q.jpegQ),
      "-f", "image2pipe", "-",
    ], { stdio: ["ignore", "pipe", "inherit"] });
    return ffmpeg;
  }

  let ffmpeg;
  if (process.env.REX_SIM_PIPE === "mkv") {
    ffmpeg = await startMkv();
  } else {
    try {
      ffmpeg = await startRaw();
    } catch (e) {
      console.error(`raw video unavailable (${e.message}); falling back to mkv pipe`);
      ffmpeg = await startMkv();
    }
  }
  watch(ffmpeg);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: stop };
}
