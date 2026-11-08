import { execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { multipartFrames } from "./frames.mjs";

const run = promisify(execFile);
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || `${homedir()}/Library/Android/sdk`;
const ADB = `${SDK}/platform-tools/adb`;
const EMULATOR = `${SDK}/emulator/emulator`;
const adb = (serial, args) => run(ADB, ["-s", serial, ...args]);

// Prints "host <arch>", "avd <name> <abi> <api level>" per emulator, then
// "on <name>" per running one that has finished booting.
const LIST_AVDS = `sdk="$1"
[ -x "$sdk/emulator/emulator" ] || exit 0
echo "host $(uname -m)"
for a in $("$sdk/emulator/emulator" -list-avds 2>/dev/null | grep -E '^[A-Za-z0-9._-]+$'); do
  c="$HOME/.android/avd/$a.avd/config.ini"
  echo "avd $a $(sed -n 's|^abi.type=||p' "$c" 2>/dev/null) $(sed -n 's|^image.sysdir.1=system-images/android-\\([0-9]*\\).*|\\1|p' "$c" 2>/dev/null)"
done
for s in $("$sdk/platform-tools/adb" devices 2>/dev/null | awk '/^emulator-/ {print $1}'); do
  [ "$("$sdk/platform-tools/adb" -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')" = 1 ] || continue
  echo "on $("$sdk/platform-tools/adb" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\\r')"
done`;

// LIST_AVDS's output -> Android devices.
export function parseEmulators(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim().split(" "));
  const running = new Set(lines.filter(([kind]) => kind === "on").map(([, name]) => name));
  // The emulator only runs images built for the Mac's own CPU.
  const host = lines.find(([kind]) => kind === "host")?.[1] === "arm64" ? "arm" : "x86";
  return lines.filter(([kind]) => kind === "avd").map(([, name, abi, api]) => ({
    platform: "android", id: `avd:${name}`, avd: name, name: name.replaceAll("_", " "),
    os: api ? `Android API ${api}` : "Android", booted: running.has(name),
    unusable: abi && !abi.startsWith(host) ? `${abi} image, can't run on this Mac` : null,
  }));
}

export async function listEmulators() {
  const { stdout } = await run("sh", ["-c", LIST_AVDS, "sh", SDK]);
  return parseEmulators(stdout);
}

export async function bootEmulator(device) {
  spawn(EMULATOR, ["-avd", device.avd, "-no-window", "-no-audio"], { detached: true, stdio: "ignore" }).unref();
}

// The emulator's serial (emulator-5554) for an AVD name, or null when it isn't running.
async function serialOf(avd) {
  const { stdout } = await run(ADB, ["devices"]);
  for (const serial of stdout.match(/^emulator-\d+/gm) ?? []) {
    const name = await adb(serial, ["emu", "avd", "name"]).then((r) => r.stdout.split("\n")[0].trim(), () => null);
    if (name === avd) return serial;
  }
  return null;
}

export async function startEmulator(device) {
  const serial = await serialOf(device.avd);
  if (!serial) throw new Error(`${device.name} has no adb connection yet`);
  const m = /(\d+)x(\d+)/.exec((await adb(serial, ["shell", "wm", "size"])).stdout);
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2220 };
  const port = await startStream(serial);
  const abort = new AbortController();
  return {
    device,
    frames: multipartFrames(`http://127.0.0.1:${port}/stream`, abort.signal),
    input: new AdbInput(serial, size),
    close: () => abort.abort(),
  };
}

const STREAM = fileURLToPath(new URL("./android-stream.mjs", import.meta.url));
// Wide enough for a pane on a Retina display; the gRPC stream slows as frames grow.
const STREAM_WIDTH = 540;

const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

// Starts android-stream.mjs for the emulator unless one already serves it
// (another pane on the same emulator), and returns its port once it listens.
// One helper per emulator, on a port from its console port: emulator-5554 -> 32554.
async function startStream(serial) {
  const consolePort = serial.split("-")[1];
  const port = 27000 + Number(consolePort);
  if (await listening(port)) return port;
  spawn(process.execPath, [STREAM, consolePort, String(port), String(STREAM_WIDTH)], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await listening(port)) return port;
  }
  throw new Error("the emulator's screen stream didn't start");
}

// USB HID keyboard usages (what the key handler produces) -> Android key codes.
const KEYCODES = {
  40: 66, 41: 111, 42: 67, 43: 61, 44: 62, 45: 69, 46: 70, 47: 71, 48: 72, 49: 73, 51: 74, 52: 75, 53: 68,
  54: 55, 55: 56, 56: 76, 74: 122, 75: 92, 76: 112, 77: 123, 78: 93, 79: 22, 80: 21, 81: 20, 82: 19,
};
for (let u = 4; u <= 29; u++) KEYCODES[u] = u + 25;
for (let u = 30; u <= 38; u++) KEYCODES[u] = u - 22;
KEYCODES[39] = 7;
const SHIFT = 225;
const MODIFIERS = new Set([224, 225, 226, 227]);
const BUTTONS = { home: 3, lock: 26 };
const VOLUME = { up: 24, down: 25 };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// The same surface as the iOS input, over `adb shell input`. Points are 0..1.
class AdbInput {
  constructor(serial, size) {
    this.serial = serial;
    this.size = size;
    this.queue = Promise.resolve();
    this.move = null;
    this.wheel = null;
    this.held = new Set();
  }

  // Commands run one at a time, in order. Input is fire-and-forget, so a failure is dropped.
  run(command) {
    this.queue = this.queue.then(command).catch(() => {});
    return this.queue;
  }

  shell(args) {
    return this.run(() => adb(this.serial, ["shell", ...args]));
  }

  px(p) {
    return [String(Math.round(p.x * (this.size.width - 1))), String(Math.round(p.y * (this.size.height - 1)))];
  }

  // Moves that pile up behind a slow command collapse into the latest one.
  touch(type, p) {
    if (type === "move") {
      const queued = this.move != null;
      this.move = p;
      if (queued) return;
      return this.run(() => {
        const at = this.move;
        this.move = null;
        return at && adb(this.serial, ["shell", "input", "motionevent", "MOVE", ...this.px(at)]);
      });
    }
    this.move = null;
    return this.shell(["input", "motionevent", type === "begin" ? "DOWN" : "UP", ...this.px(p)]);
  }

  key(type, usage) {
    if (MODIFIERS.has(usage)) return type === "down" ? this.held.add(usage) : this.held.delete(usage);
    const code = KEYCODES[usage];
    if (type !== "down" || code == null) return;
    return this.held.has(SHIFT)
      ? this.shell(["input", "keycombination", "59", String(code)])
      : this.shell(["input", "keyevent", String(code)]);
  }

  button(name) {
    return this.shell(["input", "keyevent", String(BUTTONS[name])]);
  }

  volume(direction) {
    return this.shell(["input", "keyevent", String(VOLUME[direction])]);
  }

  // dy: a fraction of the screen; positive scrolls toward what is below. Wheel
  // steps that pile up behind a slow swipe add up into one.
  scroll(dy, p) {
    const queued = this.wheel != null;
    this.wheel = { dy: (this.wheel?.dy ?? 0) + dy, p };
    if (queued) return;
    return this.run(() => {
      const { dy, p } = this.wheel;
      this.wheel = null;
      const to = { x: p.x, y: clamp01(p.y - dy) };
      return adb(this.serial, ["shell", "input", "swipe", ...this.px(p), ...this.px(to), "120"]);
    });
  }

  rotate() {
    // adb joins shell arguments into one command line, so this goes as one string.
    return this.shell(["settings put system accelerometer_rotation 0; r=$(settings get system user_rotation); settings put system user_rotation $(( (${r:-0} + 1) % 4 ))"]);
  }
}
