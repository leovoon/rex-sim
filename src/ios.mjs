import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { multipartFrames } from "./frames.mjs";

const run = promisify(execFile);

// On Xcode 27 serve-sim types through a Device Hub bridge that drops keys
// unless Device Hub is frontmost; this sends keys the way touches go.
const ENV = { ...process.env, SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD: "1" };

async function serveSim(args) {
  try {
    const { stdout } = await run("npx", ["--yes", "serve-sim@0.1.49", ...args], { env: ENV });
    return JSON.parse(stdout.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "{}");
  } catch (e) {
    throw new Error(`serve-sim: ${(e.stderr || e.message).trim().split("\n").pop()}`);
  }
}

// com.apple.CoreSimulator.SimRuntime.iOS-27-2 -> "iOS 27.2"
function runtimeLabel(key) {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(key);
  return m ? `iOS ${m[1]}.${m[2]}` : null;
}

// `xcrun simctl list devices available -j` -> iOS devices, newest OS first.
export function parseSimulators(json) {
  return Object.entries(JSON.parse(json).devices)
    .flatMap(([key, devices]) => {
      const os = runtimeLabel(key);
      return os ? devices.map((d) => ({ platform: "ios", id: d.udid, name: d.name, os, booted: d.state === "Booted" })) : [];
    })
    .sort((a, b) => b.os.localeCompare(a.os, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

export async function listSimulators() {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  return parseSimulators(stdout);
}

export async function bootSimulator(device) {
  await run("xcrun", ["simctl", "boot", device.id]);
}

// For when taps do nothing: repairs Device Hub input, which restarts
// SpringBoard. A running serve-sim keeps the input it opened before, so it
// goes too.
export async function repairInput(device) {
  await serveSim(["repair-input", "-d", device.id]);
  await serveSim(["--kill", device.id]);
}

// The running helper for this device, or a new detached one, which keeps
// running after rex-sim quits.
export async function startSimulator(device) {
  // `--list` reports every running helper whatever udid it gets.
  const listed = await serveSim(["--list", "-q", device.id]);
  const running = listed.running ? (listed.streams ?? [listed]).find((s) => s.device === device.id) : null;
  const helper = running ?? (await serveSim(["--detach", "-q", device.id]));
  const base = helper.streamUrl.replace(/\/stream\.mjpeg$/, "");
  const abort = new AbortController();
  const input = new Input(base);
  return {
    device,
    frames: multipartFrames(helper.streamUrl, abort.signal),
    input,
    close() {
      abort.abort();
      input.close();
    },
  };
}

// The helper's /ws input protocol: one tag byte, then a JSON body.
const TAG = { touch: 0x03, button: 0x04, key: 0x06, rotate: 0x07, scroll: 0x0b, keyboard: 0x0c };
// Simulator.app's Rotate Left order.
const ROTATE = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
};
// The HID consumer page, where volume up is 233 and down 234.
const CONSUMER = 12;
const VOLUME = { up: 233, down: 234 };

// Points are fractions of the screen, 0..1.
class Input {
  constructor(base) {
    this.base = base;
    this.url = `${base.replace(/^http/, "ws")}/ws`;
    this.pending = [];
    this.connect();
  }

  connect() {
    this.socket = new WebSocket(this.url);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      for (const bytes of this.pending.splice(0)) this.socket.send(bytes);
    };
    this.socket.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 500);
    };
    this.socket.onerror = () => {};
  }

  send(tag, body) {
    const json = Buffer.from(body === undefined ? "" : JSON.stringify(body));
    const bytes = new Uint8Array(json.length + 1);
    bytes[0] = tag;
    bytes.set(json, 1);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(bytes);
    else this.pending.push(bytes);
  }

  // A gesture keeps the edge its first touch had: 3 marks the home-indicator
  // band, so iOS reads a swipe up from there as going home.
  touch(type, p, edge) {
    this.send(TAG.touch, edge ? { type, x: p.x, y: p.y, edge } : { type, x: p.x, y: p.y });
  }

  button(name) {
    this.send(TAG.button, { button: name });
  }

  volume(direction) {
    this.send(TAG.button, { button: "hid", page: CONSUMER, usage: VOLUME[direction], phase: "press" });
  }

  key(type, usage) {
    this.send(TAG.key, { type, usage });
  }

  // dy: a fraction of the screen; positive scrolls toward what is below.
  scroll(dy, p) {
    this.send(TAG.scroll, { dx: 0, dy, x: p.x, y: p.y });
  }

  softwareKeyboard() {
    this.send(TAG.keyboard);
  }

  async rotate() {
    try {
      const config = await (await fetch(`${this.base}/config`)).json();
      this.send(TAG.rotate, { orientation: ROTATE[config.orientation] ?? "portrait" });
    } catch {}
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}
