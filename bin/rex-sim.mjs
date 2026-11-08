#!/usr/bin/env node
import { readdir, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { bootedDevices, startHelper, Input } from "../src/serve-sim.mjs";
import { jpegFrames, jpegSize } from "../src/mjpeg.mjs";
import { keyUsage } from "../src/keys.mjs";
import { enter, leave, fit, requestMetrics, InputParser, Screen } from "../src/terminal.mjs";

const { values: opts } = parseArgs({ options: { device: { type: "string", short: "d" }, help: { type: "boolean", short: "h" } } });
if (opts.help) {
  console.log("Usage: rex-sim [--device UDID]\n\nShows a booted iOS simulator in this terminal. Needs a terminal with Kitty graphics and pixel mouse reporting, such as Rex or Ghostty.");
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("rex-sim needs to run in a terminal.");
  process.exit(1);
}

const devices = await bootedDevices();
const device = opts.device ? devices.find((d) => d.id === opts.device) : devices[0];
if (!device) {
  console.error(opts.device ? `No booted simulator with UDID ${opts.device}.` : "No booted simulator. Boot one with `xcrun simctl boot <udid>` or from Simulator.");
  process.exit(1);
}
console.log(`Connecting to ${device.name}…`);
const helper = await startHelper(device.id);
const input = new Input(helper.base);
const screen = new Screen();
const parser = new InputParser();
const abort = new AbortController();

// A touch that starts in the bottom 7% is the home-indicator edge.
const HOME_BAND = 0.93;
const WHEEL_STEP = 0.03;

let metrics = {};
let layout = null;
let touching = null;
let latest = null;
let wake = null;
let error = null;
let drawn = 0;
let fps = 0;
let quitting = false;

function point(e) {
  return { x: (e.x - layout.x) / layout.width, y: (e.y - layout.y) / layout.height };
}

const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const clamp = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });

function onMouse(e) {
  if (!layout) return;
  const p = point(e);
  if (e.code & 64) {
    if (inside(p)) input.scroll((e.code & 1 ? 1 : -1) * WHEEL_STEP, p);
  } else if (e.release) {
    if (touching) input.touch("end", clamp(p), touching.edge);
    touching = null;
  } else if (e.code & 32) {
    if (touching) input.touch("move", clamp(p), touching.edge);
  } else if ((e.code & 3) === 0 && inside(p)) {
    touching = { edge: p.y >= HOME_BAND ? 3 : 0 };
    input.touch("begin", p, touching.edge);
  }
}

function onKey(key) {
  if (key === "\x03") return quit();
  if (key === "\x02") return input.button("home");
  const k = keyUsage(key);
  if (!k) return;
  for (const m of k.modifiers) input.key("down", m);
  input.key("down", k.usage);
  input.key("up", k.usage);
  for (const m of k.modifiers.toReversed()) input.key("up", m);
}

process.stdin.on("data", (chunk) => {
  for (const e of parser.parse(chunk)) {
    if (e.type === "mouse") onMouse(e);
    else if (e.type === "key") onKey(e.key);
    else if (e.type === "report" && e.kind === 6) {
      metrics = { cellWidth: e.width, cellHeight: e.height };
      layout = null;
    } else if (e.type === "graphics" && !e.reply.endsWith(";OK")) {
      // A terminal that can't read our temp file gets the pixels inline.
      if (screen.medium === "file") screen.medium = "direct";
      else error = e.reply.split(";").pop();
    }
  }
});

process.stdout.on("resize", () => {
  layout = null;
  screen.clear();
  requestMetrics();
});

async function quit() {
  if (quitting) return;
  quitting = true;
  abort.abort();
  input.close();
  leave();
  const prefix = `tty-graphics-protocol-rex-sim-${process.pid}-`;
  for (const name of await readdir("/tmp")) if (name.startsWith(prefix)) await rm(`/tmp/${name}`, { force: true });
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, quit);

function status() {
  const text = `${device.name} · ${fps} fps${screen.medium === "direct" ? " (inline)" : ""}${error ? ` · ${error}` : ""} · drag to swipe, type to type · ctrl-b home · ctrl-c quit`;
  return `\x1b[2m${text.slice(0, process.stdout.columns - 1)}\x1b[22m`;
}

setInterval(() => {
  fps = drawn;
  drawn = 0;
}, 1000).unref();

enter();
requestMetrics();

(async () => {
  for await (const jpg of jpegFrames(helper.streamUrl, abort.signal)) {
    latest = jpg;
    wake?.();
  }
})().catch((e) => {
  if (!quitting) error = e.message;
});

while (!quitting) {
  if (!latest || !metrics.cellWidth) {
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, 100);
    });
    continue;
  }
  const jpg = latest;
  latest = null;
  const size = jpegSize(jpg);
  if (!size) continue;
  const next = layout && layout.device.width === size.width && layout.device.height === size.height ? layout : { ...fit(metrics, size), device: size };
  if (next !== layout) {
    layout = next;
    screen.clear();
  }
  const pixels = await sharp(jpg).resize(layout.width, layout.height, { fit: "fill" }).removeAlpha().raw().toBuffer();
  if (quitting) break;
  await screen.draw(pixels, layout, status());
  drawn++;
}
