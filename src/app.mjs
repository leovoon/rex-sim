import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import sharp from "sharp";
import { listDevices, platformOf } from "./devices.mjs";
import { imageSize } from "./frames.mjs";
import { iconPng } from "./icons.mjs";
import { keyUsage } from "./keys.mjs";
import { enter, leave, requestMetrics, InputParser, Screen } from "./terminal.mjs";
import { firstCursor, fraction, hit, layout, moveCursor, pickerEntries, render } from "./view.mjs";

// The device picked last in any pane, where a new pane starts.
const STATE_DIR = `${process.env.XDG_STATE_HOME || `${homedir()}/.local/state`}/rex-sim`;
const LAST_DEVICE = `${STATE_DIR}/last-device`;
// A touch that starts in the bottom 7% is the home-indicator edge.
const HOME_BAND = 0.93;
const EDGE_BOTTOM = 3;
// A wheel step scrolls this fraction of the screen.
const WHEEL_STEP = 0.03;
// The screen's rounded corners, as a share of its width.
const CORNER = 0.13;

const clamp = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));

// The pixels of a rounded corner that are partly or wholly outside it, as
// byte offsets of their alpha in an RGBA image, with their alpha.
function cornerMask(width, height, radius) {
  const offsets = [];
  const alphas = [];
  for (let y = 0; y < radius; y++) {
    for (let x = 0; x < radius; x++) {
      const d = Math.hypot(radius - x - 0.5, radius - y - 0.5);
      const alpha = Math.round(Math.min(1, Math.max(0, radius - d + 0.5)) * 255);
      if (alpha === 255) continue;
      for (const [cx, cy] of [[x, y], [width - 1 - x, y], [x, height - 1 - y], [width - 1 - x, height - 1 - y]]) {
        offsets.push((cy * width + cx) * 4 + 3);
        alphas.push(alpha);
      }
    }
  }
  return { offsets, alphas };
}

export async function run({ device: deviceArg }) {
  const screen = new Screen();
  const parser = new InputParser();
  const booting = new Set();
  let choice = deviceArg ?? (await readFile(LAST_DEVICE, "utf8").then((s) => s.trim(), () => null));
  let devices = [];
  let view = { kind: "empty" };
  let picker = null;
  // The terminal's cell size and colors, once it answers.
  let metrics = null;
  let colors = { foreground: [200, 200, 200], background: [0, 0, 0] };
  let frameSize = null;
  let frame = null;
  let regions = [];
  let icons = new Map();
  let gesture = null;
  let paused = false;
  let repairing = null;
  let quitting = false;
  let latest = null;
  let notice = null;
  let drawn = 0;
  let fps = 0;
  let mask = null;
  let wakeLoop = null;
  let wakeDraw = null;

  // This pane's device: the one picked here or passed in, else the first running one.
  const target = () => devices.find((d) => d.id === choice) ?? devices.find((d) => d.booted) ?? null;
  const input = () => (view.kind === "streaming" ? view.session.input : null);
  const rest = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeLoop = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const nudge = () => wakeLoop?.();

  function show(next) {
    view = next;
    gesture = null;
    redraw();
  }

  function stopStream() {
    if (view.kind === "streaming") view.session.close();
  }

  function relayout() {
    if (!metrics) return;
    frame = layout({ cols: process.stdout.columns, rows: process.stdout.rows, ...metrics }, frameSize);
    const s = frame.screen;
    mask = s && cornerMask(s.width, s.height, Math.round(s.width * CORNER));
  }

  function redraw() {
    if (!frame || paused || quitting) return;
    const chrome = render({ view, picker, device: target(), fps, notice }, frame, actions);
    regions = chrome.regions;
    const placed = chrome.icons.filter((i) => icons.has(i.icon)).map((i) => ({ col: i.col, key: i.icon, png: icons.get(i.icon) }));
    screen.drawChrome({ ...chrome, icons: placed }, frame);
  }

  // The toolbar's icons, a button's size, in a color between the terminal's
  // foreground and background.
  async function renderIcons() {
    const { cellWidth, cellHeight } = metrics;
    const color = hex(mix(colors.foreground, colors.background, 0.7));
    const names = ["house", "lock", "volume-1", "volume-2", "rotate-ccw", "keyboard"];
    const pngs = await Promise.all(names.map((n) => iconPng(n, cellWidth * 2, cellHeight, color)));
    icons = new Map(names.map((n, i) => [n, pngs[i]]));
    screen.shown.header = null;
    redraw();
  }

  async function pick(device) {
    picker = null;
    choice = device.id;
    stopStream();
    redraw();
    mkdir(STATE_DIR, { recursive: true }).then(() => writeFile(LAST_DEVICE, device.id)).catch(() => {});
    if (!device.booted && !booting.has(device.id)) {
      booting.add(device.id);
      show({ kind: "booting", device });
      await platformOf(device).boot(device).catch((e) => show({ kind: "error", text: e.message }));
    }
    nudge();
  }

  function repair(device) {
    picker = null;
    repairing = device.id;
    stopStream();
    nudge();
  }

  async function openPicker() {
    const current = target();
    let entries = pickerEntries(devices, current);
    picker = { devices, cursor: firstCursor(entries, current) };
    redraw();
    const fresh = await listDevices();
    if (!picker) return;
    entries = pickerEntries(fresh, current);
    picker = { devices: fresh, cursor: firstCursor(entries, current) };
    redraw();
  }

  const COMMANDS = {
    home: () => input()?.button("home"),
    lock: () => input()?.button("lock"),
    "volume-up": () => input()?.volume("up"),
    "volume-down": () => input()?.volume("down"),
    rotate: () => input()?.rotate(),
    keyboard: () => input()?.softwareKeyboard?.(),
    repair: () => {
      const d = target();
      if (d?.booted && platformOf(d).repair) repair(d);
    },
    devices: () => openPicker(),
    device: async (id) => {
      devices = await listDevices();
      const d = devices.find((d) => d.id === id);
      if (!d) show({ kind: "error", text: `No device with id ${id}.` });
      else if (d.unusable) show({ kind: "error", text: `${d.name}: ${d.unusable}.` });
      else pick(d);
    },
    pause: () => {
      paused = true;
      stopStream();
      screen.clearFrames();
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      screen.reset();
      redraw();
      nudge();
    },
  };

  const actions = {
    command: (name, arg) => COMMANDS[name]?.(arg),
    togglePicker: () => {
      if (!picker) return openPicker();
      picker = null;
      redraw();
    },
    pick,
    repair,
    moveCursor: (delta) => {
      picker.cursor = moveCursor(pickerEntries(picker.devices, target()), picker.cursor, delta);
      redraw();
    },
    touch: (p) => {
      const i = input();
      if (!i) return;
      gesture = { edge: p.y >= HOME_BAND ? EDGE_BOTTOM : 0 };
      i.touch("begin", p, gesture.edge);
    },
    scroll: (dy, p) => input()?.scroll(dy * WHEEL_STEP, p),
  };

  function onMouse(e) {
    if (e.action === "drag" || e.action === "release") {
      const i = input();
      if (!gesture || !i || !frame.screen) return;
      i.touch(e.action === "drag" ? "move" : "end", clamp(fraction(frame.screen, e)), gesture.edge);
      if (e.action === "release") gesture = null;
      return;
    }
    hit(regions, e)?.run(e);
  }

  function onPickerKey(key) {
    if (key === "\x1b" || key === "\x10") return actions.togglePicker();
    if (key === "up" || key === "k") return actions.moveCursor(-1);
    if (key === "down" || key === "j") return actions.moveCursor(1);
    if (key === "\r") pickerEntries(picker.devices, target())[picker.cursor]?.select?.(actions);
  }

  function onKey(key) {
    if (key === "\x03") return quit();
    if (picker) return onPickerKey(key);
    if (key === "\x10") return openPicker();
    const i = input();
    const k = i && keyUsage(key);
    if (!k) return;
    for (const m of k.modifiers) i.key("down", m);
    i.key("down", k.usage);
    i.key("up", k.usage);
    for (const m of k.modifiers.toReversed()) i.key("up", m);
  }

  process.stdin.on("data", (chunk) => {
    for (const e of parser.parse(chunk)) {
      if (e.type === "mouse") onMouse(e);
      else if (e.type === "key") onKey(e.key);
      else if (e.type === "command") actions.command(e.name, e.arg);
      else if (e.type === "color") {
        colors = { ...colors, [e.slot]: e.rgb };
        if (metrics) renderIcons();
      } else if (e.type === "report" && e.kind === 6) {
        metrics = { cellWidth: e.width, cellHeight: e.height };
        relayout();
        renderIcons();
      } else if (e.type === "graphics" && !e.reply.endsWith(";OK")) {
        // A terminal that can't read our temp file gets the pixels inline.
        if (screen.medium === "file") {
          screen.medium = "direct";
          notice = "inline";
        } else notice = e.reply.split(";").pop();
        redraw();
      }
    }
  });

  process.stdout.on("resize", () => {
    screen.reset();
    relayout();
    redraw();
    requestMetrics();
  });

  async function quit() {
    if (quitting) return;
    quitting = true;
    stopStream();
    leave();
    const prefix = `tty-graphics-protocol-rex-sim-${process.pid}-`;
    for (const name of await readdir("/tmp")) if (name.startsWith(prefix)) await rm(`/tmp/${name}`, { force: true });
    process.exit(0);
  }
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, quit);

  setInterval(() => {
    fps = drawn;
    drawn = 0;
    if (view.kind === "streaming") redraw();
  }, 1000).unref();

  // Draws the newest frame whenever one is waiting; frames that arrive while
  // one draws replace each other, so a slow draw skips frames, never lags.
  async function drawFrames() {
    while (!quitting) {
      if (!latest) {
        await new Promise((resolve) => (wakeDraw = resolve));
        continue;
      }
      const { session, bytes } = latest;
      latest = null;
      if (view.session !== session || picker || paused || !metrics) continue;
      const size = imageSize(bytes);
      if (!size) continue;
      if (size.width !== frameSize?.width || size.height !== frameSize?.height) {
        frameSize = size;
        relayout();
        redraw();
      }
      const rect = frame.screen;
      if (!rect) continue;
      const pixels = await sharp(bytes).resize(rect.width, rect.height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
      if (view.session !== session || picker || paused || rect !== frame.screen) continue;
      for (let i = 0; i < mask.offsets.length; i++) pixels[mask.offsets[i]] = mask.alphas[i];
      await screen.drawFrame(pixels, rect);
      drawn++;
    }
  }

  async function stream(session) {
    try {
      for await (const bytes of session.frames) {
        latest = { session, bytes };
        wakeDraw?.();
      }
    } finally {
      session.close();
    }
  }

  // Brings the view to this pane's device: lists devices, boots or repairs as
  // asked, connects, and streams until the stream ends or something stops it.
  async function loop() {
    while (!quitting) {
      try {
        if (paused) {
          await rest(60_000);
          continue;
        }
        devices = await listDevices();
        const device = target();
        if (!device) {
          show({ kind: "empty" });
          await rest(2000);
          continue;
        }
        if (!device.booted) {
          show(booting.has(device.id) ? { kind: "booting", device } : { kind: "message", text: `${device.name} is shut down. Pick it again to boot it.` });
          await rest(1000);
          continue;
        }
        booting.delete(device.id);
        const platform = platformOf(device);
        if (repairing === device.id) {
          repairing = null;
          show({ kind: "message", text: `Repairing input on ${device.name}. SpringBoard restarts and apps close.` });
          await platform.repair(device);
        }
        show({ kind: "connecting", device });
        const session = await platform.start(device);
        if (paused || repairing || target()?.id !== device.id) {
          session.close();
          continue;
        }
        show({ kind: "streaming", session });
        await stream(session);
      } catch (e) {
        if (quitting) return;
        show({ kind: "error", text: String(e.message ?? e) });
        await rest(5000);
      }
    }
  }

  enter();
  requestMetrics();
  drawFrames();
  await loop();
}
