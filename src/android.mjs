import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { multipartFrames } from "./frames.mjs";
import { ADB, adb, EMULATOR, SDK, AdbInput } from "./adb-input.mjs";

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


