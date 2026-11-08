import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// On Xcode 27 serve-sim types through a Device Hub bridge that drops keys
// unless Device Hub is frontmost; this sends keys the way touches go.
const ENV = { ...process.env, SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD: "1" };

async function serveSim(args) {
  const { stdout } = await run("npx", ["--yes", "serve-sim@0.1.49", ...args], { env: ENV });
  return JSON.parse(stdout.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "{}");
}

export async function bootedDevices() {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  return Object.values(JSON.parse(stdout).devices).flat().map((d) => ({ id: d.udid, name: d.name }));
}

// The running helper for this device, or a new detached one.
export async function startHelper(udid) {
  // `--list` reports every running helper whatever udid it gets.
  const listed = await serveSim(["--list", "-q", udid]);
  const running = listed.running ? (listed.streams ?? [listed]).find((s) => s.device === udid) : null;
  const helper = running ?? (await serveSim(["--detach", "-q", udid]));
  return { streamUrl: helper.streamUrl, base: helper.streamUrl.replace(/\/stream\.mjpeg$/, "") };
}

// The helper's /ws input protocol: one tag byte, then a JSON body.
const TAG = { touch: 0x03, button: 0x04, key: 0x06 };

// Points are fractions of the screen, 0..1.
export class Input {
  constructor(base) {
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
    const json = Buffer.from(JSON.stringify(body));
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

  button(button) {
    this.send(TAG.button, { button });
  }

  key(type, usage) {
    this.send(TAG.key, { type, usage });
  }

  // dx, dy: a fraction of the screen; positive scrolls toward what is below.
  scroll(dy, p) {
    this.send(0x0b, { dx: 0, dy, x: p.x, y: p.y });
  }

  close() {
    this.closed = true;
    this.socket.close();
  }
}
