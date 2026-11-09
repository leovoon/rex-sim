import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import sharp from "sharp";
import { canRepair, listDevices, platformOf } from "./devices.mjs";
import { imageSize } from "./frames.mjs";
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

// Stream settings, reachable with `q` while streaming. Each row cycles
// through its values on the matching digit; choosing sets the REX_SIM_*
// environment variables (which the physical stream reads on every session
// start) and restarts the stream.
const SETTING_ROWS = [
  {
    key: "1", label: "presets", current: 1, values: [
      { label: "smooth 360", env: { REX_SIM_WIDTH: "360", REX_SIM_FPS: "60", REX_SIM_BITRATE: "3M", REX_SIM_JPEG_Q: "6" } },
      { label: "balanced 540", env: { REX_SIM_WIDTH: "540", REX_SIM_FPS: "60", REX_SIM_BITRATE: "4M", REX_SIM_JPEG_Q: "4" } },
      { label: "sharp 720", env: { REX_SIM_WIDTH: "720", REX_SIM_FPS: "60", REX_SIM_BITRATE: "8M", REX_SIM_JPEG_Q: "3" } },
      { label: "max 1080", env: { REX_SIM_WIDTH: "1080", REX_SIM_FPS: "30", REX_SIM_BITRATE: "10M", REX_SIM_JPEG_Q: "2" } },
      { label: "hevc 540", env: { REX_SIM_WIDTH: "540", REX_SIM_FPS: "60", REX_SIM_BITRATE: "4M", REX_SIM_JPEG_Q: "4", REX_SIM_CODEC: "h265" } },
    ],
  },
  { key: "2", label: "codec", current: 1, values: [
    { label: "h264", env: { REX_SIM_CODEC: "h264" } },
    { label: "h265", env: { REX_SIM_CODEC: "h265" } },
  ] },
  { key: "3", label: "width", current: 1, values: [360, 540, 720, 1080].map((w) => ({ label: String(w), env: { REX_SIM_WIDTH: String(w) } })) },
  { key: "4", label: "fps", current: 3, values: [15, 30, 60, 90].map((f) => ({ label: String(f), env: { REX_SIM_FPS: String(f) } })) },
  { key: "5", label: "bitrate", current: 1, values: ["2M", "4M", "8M", "12M"].map((b) => ({ label: b, env: { REX_SIM_BITRATE: b } })) },
  { key: "6", label: "jpeg q", current: 1, values: [8, 6, 4, 2].map((q) => ({ label: String(q), env: { REX_SIM_JPEG_Q: String(q) } })) },
  { key: "7", label: "show-touches", current: 0, values: [
    { label: "off", env: { REX_SIM_SHOW_TOUCHES: "0" } },
    { label: "on", env: { REX_SIM_SHOW_TOUCHES: "1" } },
  ] },
  { key: "8", label: "stay-awake", current: 0, values: [
    { label: "off", env: { REX_SIM_STAY_AWAKE: "0" } },
    { label: "on", env: { REX_SIM_STAY_AWAKE: "1" } },
  ] },
];

const clamp = (p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });
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
  let geometry = null;
  let regions = [];
  let gesture = null;
  let paused = false;
  let repairing = null;
  let quitting = false;
  let qualityMenu = false;
  let streamSession = null;
  // The newest frame not yet drawn, and the last one that arrived, to draw
  // again after the picker or a resize covered the screen.
  let latest = null;
  let last = null;
  let notice = null;
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
    geometry = layout({ cols: process.stdout.columns, rows: process.stdout.rows, ...metrics }, frameSize);
    const s = geometry.screen;
    mask = s && cornerMask(s.width, s.height, Math.round(s.width * CORNER));
  }

  function redraw() {
    if (!geometry || paused || quitting) return;
    const selection = `48;2;${mix(colors.foreground, colors.background, 0.16).join(";")}`;
    const chrome = render({ view, picker, device: target(), notice, selection }, geometry, actions);
    regions = chrome.regions;
    screen.drawChrome(chrome, geometry);
    if (chrome.area === null && !screen.shown.frames && last && last.session === view.session) {
      latest ??= last;
      wakeDraw?.();
    }
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

  const settingsText = () => ["stream settings (esc close)", ...SETTING_ROWS.map((r) => ` ${r.key} ${r.label} · ${r.values[r.current].label}`)].join("\n");

  function openQuality() {
    if (view.kind !== "streaming" || qualityMenu) return;
    qualityMenu = true;
    streamSession = view.session;
    show({ kind: "settings", text: settingsText() });
  }

  function closeQuality() {
    if (!qualityMenu) return;
    qualityMenu = false;
    const session = streamSession;
    streamSession = null;
    show({ kind: "streaming", session });
  }

  function cycleSetting(row) {
    row.current = (row.current + 1) % row.values.length;
    const entry = row.values[row.current];
    for (const [name, value] of Object.entries(entry.env)) process.env[name] = value;
    qualityMenu = false;
    const session = streamSession;
    streamSession = null;
    session?.close();
    show({ kind: "message", text: `${row.label}: ${entry.label} — restarting stream…` });
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
    repair: () => canRepair(target()) && repair(target()),
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
      if (!gesture || !i || !geometry.screen) return;
      i.touch(e.action === "drag" ? "move" : "end", clamp(fraction(geometry.screen, e)), gesture.edge);
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
    if (qualityMenu) {
      if (key === "\x1b") return closeQuality();
      const row = SETTING_ROWS.find((r) => r.key === key);
      if (row) return cycleSetting(row);
      return;
    }
    if (key === "\x10") return openPicker();
    if (key === "q") return openQuality();
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
        redraw();
      } else if (e.type === "report" && e.kind === 6) {
        metrics = { cellWidth: e.width, cellHeight: e.height };
        relayout();
        redraw();
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
      const rect = geometry.screen;
      if (!rect) continue;
      const pixels = await sharp(bytes).resize(rect.width, rect.height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
      if (view.session !== session || picker || paused || rect !== geometry.screen) continue;
      for (let i = 0; i < mask.offsets.length; i++) pixels[mask.offsets[i]] = mask.alphas[i];
      await screen.drawFrame(pixels, rect);
    }
  }

  async function stream(session) {
    try {
      for await (const bytes of session.frames) {
        latest = last = { session, bytes };
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
