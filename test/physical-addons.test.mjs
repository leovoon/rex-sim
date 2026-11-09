import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import sharp from "sharp";
import { deviceMatchesId } from "../src/devices.mjs";
import { imageDisplaySize, imageSize } from "../src/frames.mjs";
import {
  allocateLoopbackRange,
  deduplicatePhysicalDevices,
  ffmpegArgs,
  parseEffectiveWmSize,
  physicalFrames,
  qualityConfig,
  RotateControl,
  scrcpyArgs,
  stableHardwareId,
  touchExtents,
  transportRank,
} from "../src/physical.mjs";

const u16 = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);

// Real JPEGs (full SOS/entropy) from sharp; `jpegWithJfif` injects a JFIF
// APP0 with a known unit-0 density ratio after stripping any existing APP0.
const realJpeg = async (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: "#123456" } }).jpeg().toBuffer();

async function jpegWithJfif(x, y, base) {
  const b = base ?? (await realJpeg(240, 536));
  let rest = b.subarray(2);
  if (rest[0] === 0xff && rest[1] === 0xe0) {
    const len = rest.readUInt16BE(2);
    rest = rest.subarray(2 + len);
  }
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    u16(16),
    Buffer.from("JFIF\0"),
    Buffer.from([0x01, 0x01]),
    Buffer.from([0x00]),
    u16(x),
    u16(y),
    Buffer.from([0x00, 0x00]),
  ]);
  return Buffer.concat([b.subarray(0, 2), app0, rest]);
}

function serveFrames(frames) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store" });
      for (const f of frames) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`);
        res.write(f);
        res.write("\r\n");
      }
      res.end("--frame--\r\n");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/stream` }));
  });
}

test("parseEffectiveWmSize prefers override, falls back to physical, then default", () => {
  assert.deepEqual(parseEffectiveWmSize("Physical size: 1080x2376\n"), { width: 1080, height: 2376 });
  assert.deepEqual(parseEffectiveWmSize("Override size: 720x1600\nPhysical size: 1080x2376\n"), { width: 720, height: 1600 });
  assert.deepEqual(parseEffectiveWmSize("Physical size: 1080x2376\nOverride size: 720x1600\n"), { width: 720, height: 1600 });
  assert.deepEqual(parseEffectiveWmSize(""), { width: 1080, height: 2220 });
  assert.deepEqual(parseEffectiveWmSize("garbage"), { width: 1080, height: 2220 });
});

test("touchExtents maps display orientation onto the WM extents", () => {
  const base = { width: 1080, height: 2376 };
  assert.deepEqual(touchExtents(base, { width: 240, height: 536 }), { width: 1080, height: 2376 });
  assert.deepEqual(touchExtents(base, { width: 1197, height: 536 }), { width: 2376, height: 1080 });
  assert.deepEqual(touchExtents(base, { width: 536, height: 240 }), { width: 2376, height: 1080 });
});

test("physicalFrames keeps input touch extents in step with display orientation (real JPEGs)", async () => {
  class RecordingInput {
    constructor() {
      this.history = [];
    }
    set size(v) {
      this.history.push(v);
    }
    get size() {
      return this.history[this.history.length - 1];
    }
  }
  const input = new RecordingInput();
  const portrait = await realJpeg(240, 536);
  const landscape = await jpegWithJfif(4489, 900, portrait); // real entropy + JFIF ratio
  const { server, url } = await serveFrames([portrait, landscape]);
  const base = { width: 1080, height: 2376 };
  const ac = new AbortController();
  try {
    const got = [];
    for await (const bytes of physicalFrames(url, ac.signal, input, base)) got.push(bytes);
    assert.equal(got.length, 2);
    assert.equal(got[0].equals(portrait), true);
    assert.equal(got[1].equals(landscape), true);
    assert.deepEqual(input.history[0], { width: 1080, height: 2376 });
    assert.deepEqual(input.history[1], { width: 2376, height: 1080 });
  } finally {
    ac.abort();
    await new Promise((r) => server.close(r));
  }
});

function fakeSocket() {
  const s = new EventEmitter();
  s.writes = [];
  s.write = (buf, cb) => {
    s.writes.push(buf);
    process.nextTick(() => cb?.());
    return true;
  };
  s.destroy = () => {};
  return s;
}

test("RotateControl opens one control socket and reuses it; sends ROTATE_DEVICE", async () => {
  let connects = 0;
  let closed = 0;
  const socket = fakeSocket();
  const provider = async () => {
    connects++;
    return { socket, close: () => closed++ };
  };
  const rc = new RotateControl("s", { provider, warn: () => {} });
  let fb = 0;
  await rc.rotate(() => fb++);
  await rc.rotate(() => fb++);
  assert.equal(connects, 1);
  assert.equal(fb, 0);
  assert.equal(socket.writes.length, 2);
  assert.equal(socket.writes[0][0], 11); // ROTATE_DEVICE
  rc.close();
  assert.equal(closed, 1);
});

test("RotateControl falls back to adb rotation when the control socket fails", async () => {
  const provider = async () => {
    throw new Error("control unavailable");
  };
  const rc = new RotateControl("s", { provider, warn: () => {} });
  let fb = 0;
  await rc.rotate(() => fb++);
  await rc.rotate(() => fb++);
  assert.equal(fb, 2);
});

test("RotateControl after close performs no device action", async () => {
  const rc = new RotateControl("s", { provider: async () => { throw new Error("never"); }, warn: () => {} });
  let fb = 0;
  rc.close();
  await rc.rotate(() => fb++);
  assert.equal(fb, 0);
});

test("RotateControl close racing a pending open performs no action and closes the late socket", async () => {
  let resolveProvider;
  let closedLate = false;
  const provider = () => new Promise((res) => { resolveProvider = res; });
  const rc = new RotateControl("s", { provider, warn: () => {} });
  let fb = 0;
  const pending = rc.rotate(() => fb++);
  rc.close();
  resolveProvider({ socket: fakeSocket(), close: () => { closedLate = true; } });
  await pending;
  assert.equal(fb, 0); // quiet cancellation
  assert.equal(closedLate, true);
});

test("RotateControl handles runtime socket errors and reopens on the next rotate", async () => {
  let connects = 0;
  const sockets = [fakeSocket(), fakeSocket()];
  const provider = async () => ({ socket: sockets[connects++], close: () => {} });
  const rc = new RotateControl("s", { provider, warn: () => {} });
  let fb = 0;
  await rc.rotate(() => fb++);
  sockets[0].emit("error", new Error("connection reset")); // no uncaught
  await rc.rotate(() => fb++);
  assert.equal(connects, 2);
  assert.equal(fb, 0);
});

test("RotateControl writes directly and falls back when the write fails", async () => {
  const socket = fakeSocket();
  socket.write = (buf, cb) => { cb(new Error("EPIPE")); };
  const rc = new RotateControl("s", { provider: async () => ({ socket, close: () => {} }), warn: () => {} });
  let fb = 0;
  await rc.rotate(() => fb++);
  assert.equal(fb, 1);
});

test("RotateControl does not leak fallback rejections", async () => {
  let warns = 0;
  const rc = new RotateControl("s", {
    provider: async () => { throw new Error("control down"); },
    warn: () => { warns++; },
  });
  await rc.rotate(() => { throw new Error("adb down"); });
  assert.equal(warns, 2); // control failure warn + fallback failure warn
});

const device = (serial, extra = {}) => ({ platform: "android-physical", id: serial, serial, name: serial, os: "Android", booted: false, unusable: null, ...extra });

const TEST_MDNS = "adb-TESTPHONE01-token._adb-tls-connect._tcp";
const TEST_TCP = "192.0.2.10:12345";
const TEST_HW = "TESTPHONE01";

test("stableHardwareId rejects placeholders", () => {
  assert.equal(stableHardwareId(""), null);
  assert.equal(stableHardwareId("unknown"), null);
  assert.equal(stableHardwareId("UNKNOWN"), null);
  assert.equal(stableHardwareId("0"), null);
  assert.equal(stableHardwareId("none"), null);
  assert.equal(stableHardwareId(TEST_HW), TEST_HW);
});

test("deduplicatePhysicalDevices groups one phone over two transports and keeps aliases", () => {
  const out = deduplicatePhysicalDevices([
    device(TEST_MDNS, { hardwareId: TEST_HW }),
    device(TEST_TCP, { hardwareId: TEST_HW }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].serial, TEST_MDNS); // mDNS preferred over TCP
  assert.deepEqual(out[0].aliases, [TEST_TCP]);
  assert.equal(deviceMatchesId(out[0], TEST_MDNS), true);
  assert.equal(deviceMatchesId(out[0], TEST_TCP), true);
});

test("deduplicatePhysicalDevices prefers a usable transport over an offline one", () => {
  const out = deduplicatePhysicalDevices([
    device("adb-TESTPHONE02-usb", { hardwareId: "TESTPHONE02", unusable: "offline" }),
    device("adb-TESTPHONE02-mdns", { hardwareId: "TESTPHONE02" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].serial, "adb-TESTPHONE02-mdns");
  assert.equal(out[0].unusable, null);
  assert.deepEqual(out[0].aliases, ["adb-TESTPHONE02-usb"]);
});

test("deduplicatePhysicalDevices keeps distinct hardware ids and unknown ids separate", () => {
  const out = deduplicatePhysicalDevices([
    device("adb-TESTA", { hardwareId: "TESTA" }),
    device("adb-TESTB", { hardwareId: "TESTB" }),
    device("adb-UNKNOWN1", { hardwareId: null }),
    device("adb-UNKNOWN2", { hardwareId: undefined }),
  ]);
  assert.equal(out.length, 4);
  assert.ok(out.every((d) => !d.aliases));
});

test("transportRank: USB < mDNS < TCP", () => {
  assert.equal(transportRank("adb-TESTUSB"), 0);
  assert.equal(transportRank(TEST_MDNS), 1);
  assert.equal(transportRank(TEST_TCP), 2);
});

function encodeSegment(size) {
  const out = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${size}:r=5:d=0.4`,
    "-c:v", "libx264", "-preset", "ultrafast",
    "-f", "h264", "-",
  ]);
  if (out.status !== 0) throw new Error(out.stderr.toString());
  return out.stdout;
}

test("full-rotation pipeline: portrait→landscape→portrait keeps ordered display sizes", { timeout: 30000 }, async (t) => {
  const which = spawnSync("sh", ["-c", "command -v ffmpeg"]);
  if (which.status !== 0) {
    t.skip("ffmpeg not installed");
    return;
  }
  // Parent fixture: three H.264 segments (2 frames each), encoded separately,
  // then concatenated and decoded with the actual ffmpegArgs pipeline.
  const segments = [encodeSegment("240x536"), encodeSegment("536x240"), encodeSegment("240x536")];
  const decoded = spawnSync("ffmpeg", ffmpegArgs(qualityConfig({}), ["-f", "h264", "-i", "pipe:0"]), { input: Buffer.concat(segments) });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frames = [];
  for (let i = 0; i + 1 < decoded.stdout.length; ) {
    if (decoded.stdout[i] === 0xff && decoded.stdout[i + 1] === 0xd8) {
      let j = i + 2;
      while (j + 1 < decoded.stdout.length && !(decoded.stdout[j] === 0xff && decoded.stdout[j + 1] === 0xd9)) j++;
      if (j + 1 < decoded.stdout.length) {
        frames.push(decoded.stdout.subarray(i, j + 2));
        i = j + 2;
        continue;
      }
    }
    i++;
  }
  assert.equal(frames.length, 6, `expected exactly 6 frames, got ${frames.length}`);
  for (const f of frames) {
    assert.deepEqual(imageSize(f), { width: 240, height: 536 }); // SOF stays fixed
  }
  const displays = frames.map((f) => imageDisplaySize(f));
  const orientations = displays.map((d) => (d.width > d.height ? "L" : "P"));
  assert.deepEqual(orientations, ["P", "P", "L", "L", "P", "P"]);
  for (const d of displays) {
    assert.equal(d.height, 536);
    if (d.width > d.height) {
      assert.ok(Math.abs(d.width - 1197) < 60, `landscape display width ${d.width}`);
    } else {
      assert.equal(d.width, 240);
    }
  }

  // Cheap physicalFrames extents assertion on these real frames.
  class RecordingInput {
    constructor() {
      this.history = [];
    }
    set size(v) {
      this.history.push(v);
    }
    get size() {
      return this.history[this.history.length - 1];
    }
  }
  const input = new RecordingInput();
  const { server, url } = await serveFrames(frames);
  const base = { width: 1080, height: 2376 };
  const ac = new AbortController();
  try {
    const got = [];
    for await (const bytes of physicalFrames(url, ac.signal, input, base)) got.push(bytes);
    assert.equal(got.length, 6);
  } finally {
    ac.abort();
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(input.history, [
    { width: 1080, height: 2376 },
    { width: 1080, height: 2376 },
    { width: 2376, height: 1080 },
    { width: 2376, height: 1080 },
    { width: 1080, height: 2376 },
    { width: 1080, height: 2376 },
  ]);
});

test("allocateLoopbackRange hands out distinct ports; scrcpyArgs carries the range", async () => {
  const a = await allocateLoopbackRange();
  const b = await allocateLoopbackRange();
  assert.ok(a.start > 0);
  assert.ok(a.end >= a.start && a.end <= 65535);
  assert.ok(a.end - a.start >= 16);
  assert.notEqual(a.start, b.start);
  const withRange = scrcpyArgs(qualityConfig({}), "/tmp/x.mkv", "ser", a);
  assert.ok(withRange.includes(`--port=${a.start}:${a.end}`));
  const plain = scrcpyArgs(qualityConfig({}), "/tmp/x.mkv", "ser");
  assert.ok(!plain.some((x) => x.startsWith("--port=")));
});
