import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || `${homedir()}/Library/Android/sdk`;
export const ADB = `${SDK}/platform-tools/adb`;
export const EMULATOR = `${SDK}/emulator/emulator`;

export const adb = (serial, args) => run(ADB, ["-s", serial, ...args]);

// USB HID keyboard usages (what the key handler produces) -> Android key codes.
export const KEYCODES = {
  40: 66, 41: 111, 42: 67, 43: 61, 44: 62, 45: 69, 46: 70, 47: 71, 48: 72, 49: 73, 51: 74, 52: 75, 53: 68,
  54: 55, 55: 56, 56: 76, 74: 122, 75: 92, 76: 112, 77: 123, 78: 93, 79: 22, 80: 21, 81: 20, 82: 19,
};
for (let u = 4; u <= 29; u++) KEYCODES[u] = u + 25;
for (let u = 30; u <= 38; u++) KEYCODES[u] = u - 22;
KEYCODES[39] = 7;
export const SHIFT = 225;
export const MODIFIERS = new Set([224, 225, 226, 227]);
export const BUTTONS = { home: 3, lock: 26 };
export const VOLUME = { up: 24, down: 25 };
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// The same surface as the iOS input, over `adb shell input`. Points are 0..1.
export class AdbInput {
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
