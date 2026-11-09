#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const { values: opts } = parseArgs({ options: { device: { type: "string", short: "d" }, help: { type: "boolean", short: "h" } } });
if (opts.help) {
  console.log(`Usage: rex-sim [--device ID]

Shows an iOS simulator, Android emulator, or real Android device in this
terminal. Click to tap, drag to swipe, scroll, and type. Ctrl-P picks a
device, Ctrl-C quits.

--device  a simulator's UDID, avd:<name> for an emulator, or an adb serial
          (like 192.0.2.10:5555) for a physical device. Without it, the
          device picked last, else the first running one.

Needs a terminal with Kitty graphics and pixel mouse reporting, such as Rex.`);
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("rex-sim needs to run in a terminal.");
  process.exit(1);
}

// Keeps the message on screen until a key, as the pane closes when rex-sim exits.
function fail(message) {
  process.stdout.write("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1016l\x1b[?1006l\x1b[?1002l\x1b[?25h\x1b[?1049l");
  console.error(`rex-sim: ${message}\n\nPress any key to close.`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(1));
}

// The first run installs sharp, which shrinks each frame to the pane.
async function main() {
  if (!existsSync(join(ROOT, "node_modules", "sharp"))) {
    console.log("Installing rex-sim's dependencies…");
    const npm = join(dirname(process.execPath), "npm");
    const r = spawnSync(existsSync(npm) ? npm : "npm", ["install", "--omit=dev"], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`npm install failed in ${ROOT}.`);
  }
  const { run } = await import("../src/app.mjs");
  await run(opts);
}

main().catch((e) => fail(e.message ?? String(e)));
