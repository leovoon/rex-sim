import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { startStream, _setVideoSocketProvider, scrcpyArgs, ffmpegArgs, qualityConfig, ViewerSink } from "../src/physical.mjs";
import { multipartFrames } from "../src/frames.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake tool executables -------------------------------------------------
// Real scrcpy/ffmpeg are not needed: the pipeline logic is what we test. The
// fake ffmpeg emits one JPEG every 25ms on stdout unless the RAW_FAKE /
// MKV_FAKE environment variables say "silent" or "exit"; it distinguishes raw
// (stdin) from mkv (fifo) by its arguments. FAKE_FRAME_COUNT limits the
// number of frames (0 = unlimited).
const binDir = mkdtempSync(join(tmpdir(), "rex-bin-"));
const FAKE_SCRCPY = join(binDir, "scrcpy");
const FAKE_FFMPEG = join(binDir, "ffmpeg");
writeFileSync(FAKE_SCRCPY, `#!/usr/bin/env node
const iv = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { clearInterval(iv); process.exit(0); });
`);
writeFileSync(FAKE_FFMPEG, `#!/usr/bin/env node
const mode = process.argv.includes("pipe:0") ? (process.env.RAW_FAKE || "frames") : (process.env.MKV_FAKE || "frames");
if (mode === "exit") process.exit(3);
const kb = Number(process.env.FAKE_FRAME_KB || 8);
const ms = Number(process.env.FAKE_FRAME_MS || 25);
const max = Number(process.env.FAKE_FRAME_COUNT || 0);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(kb * 1024, 7), Buffer.from([0xff, 0xd9])]);
let n = 0;
const iv = setInterval(() => {
  if (mode === "frames" && (!max || n < max)) { process.stdout.write(jpeg); n++; }
}, ms);
process.on("SIGTERM", () => { clearInterval(iv); process.exit(0); });
`);
chmodSync(FAKE_SCRCPY, 0o755);
chmodSync(FAKE_FFMPEG, 0o755);
process.env.REX_SIM_SCRCPY = FAKE_SCRCPY;
process.env.REX_SIM_FFMPEG = FAKE_FFMPEG;
delete process.env.REX_SIM_PIPE;
process.env.RAW_FAKE = "frames";
process.env.MKV_FAKE = "frames";

after(() => {
  delete process.env.REX_SIM_SCRCPY;
  delete process.env.REX_SIM_FFMPEG;
  delete process.env.REX_SIM_PIPE;
  delete process.env.RAW_FAKE;
  delete process.env.MKV_FAKE;
  delete process.env.FAKE_FRAME_KB;
  delete process.env.FAKE_FRAME_MS;
  delete process.env.FAKE_FRAME_COUNT;
  _setVideoSocketProvider(() => import("./scrcpy-control.mjs"));
  rmSync(binDir, { recursive: true, force: true });
});

// ---- fake raw video socket provider ----------------------------------------
function makeProvider() {
  const sockets = new Set();
  let closed = false;
  return {
    sockets,
    get closed() {
      return closed;
    },
    startVideoSocket: async () => {
      const s = new EventEmitter();
      sockets.add(s);
      s.dest = null;
      s.pipe = (dest) => { s.dest = dest; return dest; };
      s.write = (buf) => { if (s.dest) s.dest.write(buf); };
      s.end = () => {};
      s.destroy = () => process.nextTick(() => s.emit("close"));
      s.fail = () => s.emit("error", new Error("stale raw socket error"));
      return {
        socket: s,
        close: () => { closed = true; s.destroy(); },
      };
    },
  };
}

// Collect frames for ms milliseconds. An AbortController timer is the
// independent hard bound: even if the producer freezes and no frame ever
// arrives, the loop ends. `ended` means iteration terminated on its own
// (natural stream end or error); `timedOut` marks the hard-bound abort.
async function collectFrames(port, ms, ac) {
  const frames = [];
  let ended = false;
  let timedOut = false;
  const hardBound = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, ms + 500);
  try {
    const deadline = Date.now() + ms;
    let broke = false;
    for await (const bytes of multipartFrames(`http://127.0.0.1:${port}/stream`, ac.signal)) {
      frames.push({ bytes, at: Date.now() });
      if (Date.now() >= deadline) {
        broke = true;
        break;
      }
    }
    if (!broke) ended = true; // natural end/abort, not our own deadline break
  } catch {
    ended = true;
  } finally {
    clearTimeout(hardBound);
    ac.abort();
  }
  return { frames, ended, timedOut };
}

function countJpegs(buf) {
  let count = 0;
  let i = 0;
  while (i + 1 < buf.length) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      let j = i + 2;
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) j++;
      if (j + 1 < buf.length) {
        count++;
        i = j + 2;
        continue;
      }
    }
    i++;
  }
  return count;
}

const leftoverDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("rex-sim-")).sort();

test("a healthy raw stream survives past the 6s watchdog", async () => {
  delete process.env.REX_SIM_PIPE;
  process.env.RAW_FAKE = "frames";
  const provider = makeProvider();
  _setVideoSocketProvider(() => Promise.resolve(provider));
  const ac = new AbortController();
  const t0 = Date.now();
  let stream;
  let got;
  try {
    stream = await startStream("fake-serial");
    got = await collectFrames(stream.port, 6500, ac);
  } finally {
    stream?.close();
    ac.abort();
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 6500, `collection window was only ${elapsed}ms`);
  assert.equal(got.ended, false, "stream terminated unexpectedly (watchdog?)");
  assert.ok(got.frames.length > 10, `expected frames, got ${got.frames.length}`);
  assert.ok(got.frames.some((f) => f.at - t0 > 6000), "no frame arrived after 6s");
});

test("raw no-frame timeout falls back to mkv once; stale raw events don't stop it", async () => {
  delete process.env.REX_SIM_PIPE;
  process.env.RAW_FAKE = "silent";
  process.env.MKV_FAKE = "frames";
  const provider = makeProvider();
  _setVideoSocketProvider(() => Promise.resolve(provider));
  const { port, close } = await startStream("fake-serial", { rawTimeoutMs: 250, mkvTimeoutMs: 5000 });
  const got = await collectFrames(port, 1500, new AbortController());
  const raw = [...provider.sockets][0];
  raw?.fail(); // stale raw socket error after the transition
  const after = await collectFrames(port, 500, new AbortController());
  close();
  assert.ok(got.frames.length >= 5, `mkv fallback delivered no frames (${got.frames.length})`);
  assert.ok(after.frames.length >= 2, `stale raw event stopped the mkv stream`);
});

test("raw producer exit without frames falls back to mkv", async () => {
  delete process.env.REX_SIM_PIPE;
  process.env.RAW_FAKE = "exit";
  process.env.MKV_FAKE = "frames";
  const provider = makeProvider();
  _setVideoSocketProvider(() => Promise.resolve(provider));
  const { port, close } = await startStream("fake-serial", { mkvTimeoutMs: 5000 });
  const got = await collectFrames(port, 1500, new AbortController());
  close();
  assert.ok(got.frames.length >= 5, `fallback after raw exit delivered no frames (${got.frames.length})`);
});

test("an mkv fallback that never delivers a first frame stops", async () => {
  delete process.env.REX_SIM_PIPE;
  process.env.RAW_FAKE = "silent";
  process.env.MKV_FAKE = "silent";
  const provider = makeProvider();
  _setVideoSocketProvider(() => Promise.resolve(provider));
  const { port, close } = await startStream("fake-serial", { rawTimeoutMs: 200, mkvTimeoutMs: 400 });
  const t0 = Date.now();
  const got = await collectFrames(port, 3000, new AbortController());
  close();
  assert.equal(got.frames.length, 0);
  assert.ok(got.ended, "stream should have stopped after the mkv no-frame timeout");
  assert.equal(got.timedOut, false, "stream had to be force-aborted");
  assert.ok(Date.now() - t0 < 2500, "mkv timeout did not stop promptly");
});

test("aborting during deferred startup cleans the late producer and never watches it", async () => {
  let closed = false;
  _setVideoSocketProvider(() => Promise.resolve({
    startVideoSocket: async () => {
      await sleep(300);
      const s = new EventEmitter();
      s.pipe = () => s;
      s.write = () => {};
      s.end = () => {};
      s.destroy = () => {};
      return { socket: s, close: () => { closed = true; s.destroy(); } };
    },
  }));
  const ac = new AbortController();
  const starting = startStream("fake-serial", { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(starting, /closed while starting/);
  assert.equal(closed, true, "late provider close was not called");
});

test("pre-aborted signal starts no producer", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(startStream("fake-serial", { signal: ac.signal }), /closed while starting/);
});

test("repeated close/restart leaves no fifo litter", async () => {
  process.env.REX_SIM_PIPE = "mkv";
  process.env.MKV_FAKE = "frames";
  const before = leftoverDirs();
  for (let i = 0; i < 2; i++) {
    const { port, close } = await startStream("fake-serial");
    const got = await collectFrames(port, 400, new AbortController());
    assert.ok(got.frames.length >= 1);
    close();
    close(); // double close is idempotent
  }
  assert.deepEqual(leftoverDirs(), before);
});

function fakeRes(returnValue) {
  const r = new EventEmitter();
  r.destroyed = false;
  r.writes = [];
  r.write = (frame) => { r.writes.push(frame); return returnValue; };
  r.destroy = () => { r.destroyed = true; };
  return r;
}

const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([seed]), Buffer.from([0xff, 0xd9])]);

test("ViewerSink: a drain with no newer frame never resends", () => {
  const sink = new ViewerSink();
  const res = fakeRes(false); // every write reports backpressure
  const a = jpeg(1);
  sink.updateLatest(a, 1);
  sink.send(res, a, 1);
  res.emit("drain");
  res.emit("drain");
  assert.equal(res.writes.length, 1); // the queued frame is never resent
  assert.equal(res.writes[0].includes(a), true);
});

test("ViewerSink: stalled viewers skip intervening frames and catch up to fresh latest", () => {
  const sink = new ViewerSink();
  const res = fakeRes(false);
  const a = jpeg(1);
  const b = jpeg(2);
  const c = jpeg(3);
  sink.updateLatest(a, 1);
  sink.send(res, a, 1); // write 1, stalled
  sink.updateLatest(b, 2);
  sink.send(res, b, 2); // skipped while stalled
  sink.updateLatest(c, 3);
  sink.send(res, c, 3); // skipped while stalled
  assert.equal(res.writes.length, 1);
  res.emit("drain"); // fresh latest is c/3 -> exactly one catch-up
  assert.equal(res.writes.length, 2);
  assert.equal(res.writes[1].includes(c), true);
  assert.equal(res.writes[1].includes(b), false);
  res.emit("drain"); // nothing newer -> no third write
  assert.equal(res.writes.length, 2);
});

test("ViewerSink: a drain unstalls, and the next frame flows", () => {
  const sink = new ViewerSink();
  const res = fakeRes(false);
  const a = jpeg(1);
  const b = jpeg(2);
  sink.updateLatest(a, 1);
  sink.send(res, a, 1);
  res.emit("drain");
  sink.updateLatest(b, 2);
  sink.send(res, b, 2);
  assert.equal(res.writes.length, 2);
});

test("ViewerSink ignores destroyed viewers", () => {
  const sink = new ViewerSink();
  const res = fakeRes(false);
  const a = jpeg(1);
  sink.updateLatest(a, 1);
  sink.send(res, a, 1);
  res.destroy();
  res.emit("drain");
  assert.equal(res.writes.length, 1); // no write to a destroyed viewer
  sink.updateLatest(a, 2);
  sink.send(res, a, 2); // destroyed -> skipped
  assert.equal(res.writes.length, 1);
});

test("stop always closes the listening server, even when called twice", async () => {
  process.env.REX_SIM_PIPE = "mkv";
  process.env.MKV_FAKE = "frames";
  const { port, close } = await startStream("fake-serial");
  const got = await collectFrames(port, 300, new AbortController());
  assert.ok(got.frames.length >= 1);
  close();
  close();
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(); });
    s.once("error", () => { s.destroy(); reject(new Error("still listening")); });
  }), /still listening/);
});

test("a single frame larger than the writable high-water mark is sent once, not repeatedly", async () => {
  delete process.env.REX_SIM_PIPE;
  process.env.RAW_FAKE = "frames";
  process.env.FAKE_FRAME_KB = "256";
  process.env.FAKE_FRAME_MS = "25";
  process.env.FAKE_FRAME_COUNT = "1";
  const provider = makeProvider();
  _setVideoSocketProvider(() => Promise.resolve(provider));
  const stream = await startStream("fake-serial", { rawTimeoutMs: 60000 });
  const got = await collectFrames(stream.port, 700, new AbortController());
  stream.close();
  assert.equal(got.frames.length, 1, `expected exactly one frame, got ${got.frames.length}`);
});

test("scrcpy args: audio-off uses --no-audio and --no-control", () => {
  const args = scrcpyArgs(qualityConfig({}), "/tmp/x.mkv", "ser");
  assert.ok(args.includes("--no-window"));
  assert.ok(args.includes("--no-video-playback"));
  assert.ok(!args.includes("--no-playback"));
  assert.ok(args.includes("--no-audio"));
  assert.ok(args.includes("--no-control"));
  assert.equal(args[args.indexOf("-s") + 1], "ser");
  assert.ok(!args.some((a) => a.startsWith("--audio-")));
});

test("scrcpy args: audio-on uses native playback knobs, no second output flag", () => {
  const args = scrcpyArgs(qualityConfig({ REX_SIM_AUDIO: "1", REX_SIM_AUDIO_SOURCE: "mic", REX_SIM_AUDIO_CODEC: "aac" }), "/tmp/x.mkv", "ser");
  assert.ok(!args.includes("--no-audio"));
  assert.ok(args.includes("--audio-source=mic"));
  assert.ok(args.includes("--audio-codec=aac"));
  assert.ok(args.includes("--no-control"));
  assert.ok(!args.some((a) => a.includes("audiotoolbox") || a.includes("0:a")));
});

test("scrcpy args: server options replace --no-control with disabled input", () => {
  for (const env of [
    { REX_SIM_SHOW_TOUCHES: "1" },
    { REX_SIM_STAY_AWAKE: "1" },
    { REX_SIM_POWER_OFF_ON_CLOSE: "1" },
  ]) {
    const args = scrcpyArgs(qualityConfig(env), "/tmp/x.mkv", "ser");
    assert.ok(!args.includes("--no-control"), JSON.stringify(env));
    assert.ok(args.includes("--keyboard=disabled"));
    assert.ok(args.includes("--mouse=disabled"));
    assert.ok(args.includes("--gamepad=disabled"));
    assert.ok(args.includes("--no-clipboard-autosync"));
  }
  assert.ok(scrcpyArgs(qualityConfig({ REX_SIM_SHOW_TOUCHES: "1" }), "/tmp/x.mkv", "ser").includes("--show-touches"));
  assert.ok(scrcpyArgs(qualityConfig({ REX_SIM_STAY_AWAKE: "1" }), "/tmp/x.mkv", "ser").includes("--stay-awake"));
  assert.ok(scrcpyArgs(qualityConfig({ REX_SIM_POWER_OFF_ON_CLOSE: "1" }), "/tmp/x.mkv", "ser").includes("--power-off-on-close"));
});

test("scrcpy CLI accepts every flag we emit (skipped without scrcpy)", async (t) => {
  const which = spawnSync("sh", ["-c", "command -v scrcpy"]);
  if (which.status !== 0) {
    t.skip("scrcpy not installed");
    return;
  }
  const help = spawnSync("scrcpy", ["--help"]).stdout.toString();
  const flags = [
    "--no-window", "--no-video-playback", "--no-audio", "--no-control",
    "--keyboard=disabled", "--mouse=disabled", "--gamepad=disabled",
    "--no-clipboard-autosync", "--show-touches", "--stay-awake",
    "--power-off-on-close", "--audio-source", "--audio-codec", "--video-codec",
    "--max-size", "--video-bit-rate", "--max-fps", "--record", "--record-format",
  ];
  for (const f of flags) {
    const base = f.split("=")[0];
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.ok(new RegExp(escaped).test(help), `flag missing from scrcpy --help: ${f}`);
  }
});

test("ffmpeg args: video-only passthrough MJPEG, no audio output", () => {
  const args = ffmpegArgs(qualityConfig({}), ["-f", "matroska", "-i", "/tmp/x.mkv"]);
  assert.equal(args[args.indexOf("-map") + 1], "0:v:0");
  assert.ok(args.includes("-an"));
  assert.ok(args.includes("-sn"));
  assert.equal(args[args.indexOf("-analyzeduration") + 1], "1"); // live-verified first frames ~1s
  assert.equal(args[args.indexOf("-fpsprobesize") + 1], "0");
  assert.ok(args.indexOf("-fpsprobesize") < args.indexOf("-i"), "-fpsprobesize must precede -i");
  assert.equal(args[args.indexOf("-fps_mode") + 1], "passthrough");
  assert.equal(args[args.indexOf("-enc_time_base:v") + 1], "1:1000000");
  assert.ok(args.includes("image2pipe"));
  assert.ok(!args.some((a) => a.includes("audiotoolbox") || a.includes("0:a")));
});

test("ffmpeg passthrough keeps the frame count (skipped without ffmpeg)", async (t) => {
  const which = spawnSync("sh", ["-c", "command -v ffmpeg"]);
  if (which.status !== 0) {
    t.skip("ffmpeg not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "rex-ff-"));
  try {
    const src = join(dir, "in.mkv");
    // 60 frames at 60fps, select every 20th..22nd => exactly 9 frames.
    const gen = spawnSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=60:duration=1",
      "-vf", "select='lt(mod(n,20),3)'",
      "-fps_mode", "vfr",
      "-c:v", "libx264", "-preset", "ultrafast",
      src,
    ]);
    assert.equal(gen.status, 0, gen.stderr.toString());
    const out = spawnSync("ffmpeg", ffmpegArgs(qualityConfig({}), ["-f", "matroska", "-i", src]));
    assert.equal(out.status, 0, out.stderr.toString());
    assert.equal(countJpegs(out.stdout), 9, `expected exactly 9 frames`);
    assert.ok(!/non[- ]monotonic|non monotonically increasing/i.test(out.stderr.toString()), out.stderr.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
