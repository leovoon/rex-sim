// Serves an Android emulator's screen as a multipart stream of PNGs, the shape
// serve-sim's MJPEG has, so the mod reads both the same way.
// usage: node android-stream.mjs <console port, e.g. 5554> <listen port> <width>
//
// Frames come from the emulator's gRPC streamScreenshot, which pushes a frame
// whenever the screen changes (~36 fps at 540 wide, against ~6 fps for adb
// screencap). One gRPC stream feeds every viewer; the helper exits a few
// seconds after the last one leaves, or when the emulator goes away.
import http from "node:http";
import http2 from "node:http2";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const [, , consolePort, listenPort, width = "540"] = process.argv;
const IDLE_MS = 3000;

// The emulator advertises its gRPC port and token in a discovery file per instance.
function discover() {
  const dir = `${homedir()}/Library/Caches/TemporaryItems/avd/running`;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ini"))) {
    const ini = readFileSync(`${dir}/${name}`, "utf8");
    const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(ini)?.[1];
    if (get("port.serial") === consolePort) return { port: get("grpc.port"), token: get("grpc.token") };
  }
  throw new Error(`no running emulator on console port ${consolePort}`);
}

const varint = (n) => {
  const out = [];
  for (; n > 127; n >>>= 7) out.push((n & 127) | 128);
  out.push(n);
  return out;
};

// The `image` bytes (field 4) of an Image message.
function imageBytes(msg) {
  let i = 0;
  const read = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const b = msg[i++];
      v += (b & 127) * 2 ** shift;
      if (!(b & 128)) return v;
    }
  };
  while (i < msg.length) {
    const key = read();
    const type = key & 7;
    if (type === 2) {
      const len = read();
      if (key >> 3 === 4) return msg.subarray(i, i + len);
      i += len;
    } else if (type === 0) read();
    else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else return null;
  }
  return null;
}

const viewers = new Set();
// The emulator only sends a frame when the screen changes, so a new viewer starts from the last one.
let last = null;
let idle = null;
const stopSoon = () => { idle ??= setTimeout(() => process.exit(0), IDLE_MS); };

const { port, token } = discover();
const grpc = http2.connect(`http://127.0.0.1:${port}`);
grpc.on("error", () => process.exit(1));
// ImageFormat { format: PNG, width, height }: the frame fits inside width x height.
const format = [8, 0, 24, ...varint(Number(width)), 32, ...varint(Number(width) * 4)];
const call = grpc.request({
  ":method": "POST",
  ":path": "/android.emulation.control.EmulatorController/streamScreenshot",
  "content-type": "application/grpc",
  te: "trailers",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
// gRPC frames a message as [compressed flag][u32 length][bytes].
const prefix = Buffer.alloc(5);
prefix.writeUInt32BE(format.length, 1);
call.end(Buffer.concat([prefix, Buffer.from(format)]));
call.on("error", () => process.exit(1));
call.on("close", () => process.exit(0));

let pending = Buffer.alloc(0);
call.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const len = pending.readUInt32BE(1);
    if (pending.length < 5 + len) break;
    const png = imageBytes(pending.subarray(5, 5 + len));
    pending = pending.subarray(5 + len);
    // An inactive display sends empty images.
    if (!png?.length) continue;
    last = Buffer.from(png);
    for (const res of viewers) send(res, last);
  }
});

function send(res, png) {
  res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`);
  res.write(png);
  res.write("\r\n");
}

http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store" });
  viewers.add(res);
  if (last) send(res, last);
  clearTimeout(idle);
  idle = null;
  res.on("close", () => {
    viewers.delete(res);
    if (!viewers.size) stopSoon();
  });
}).listen(Number(listenPort), "127.0.0.1", stopSoon);
