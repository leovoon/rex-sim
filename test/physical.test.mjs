import assert from "node:assert/strict";
import { test } from "node:test";
import { MjpegParser, parseDevices, qualityConfig } from "../src/physical.mjs";

const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([seed]), Buffer.from([0xff, 0xd9])]);

test("physical devices: emulators skipped, states surfaced", () => {
  const out = [
    "List of devices attached",
    "emulator-5554\tdevice",
    "192.0.2.10:5555\tdevice",
    "R58M10ABCDE\tunauthorized",
    "OFFLINE12345\toffline",
    "",
  ].join("\n");
  assert.deepEqual(parseDevices(out), [
    { platform: "android-physical", id: "192.0.2.10:5555", serial: "192.0.2.10:5555", name: "192.0.2.10:5555", os: "Android", booted: false, unusable: null },
    { platform: "android-physical", id: "R58M10ABCDE", serial: "R58M10ABCDE", name: "R58M10ABCDE", os: "Android", booted: false, unusable: "authorize this computer on the phone (USB debugging prompt)" },
    { platform: "android-physical", id: "OFFLINE12345", serial: "OFFLINE12345", name: "OFFLINE12345", os: "Android", booted: false, unusable: "offline" },
  ]);
});

test("mDNS serials with disambiguation spaces parse", () => {
  const out = [
    "List of devices attached",
    "adb-ABCDE12345FAKE (2)._adb-tls-connect._tcp\tdevice",
    "",
  ].join("\n");
  assert.deepEqual(parseDevices(out), [
    { platform: "android-physical", id: "adb-ABCDE12345FAKE (2)._adb-tls-connect._tcp", serial: "adb-ABCDE12345FAKE (2)._adb-tls-connect._tcp", name: "adb-ABCDE12345FAKE (2)._adb-tls-connect._tcp", os: "Android", booted: false, unusable: null },
  ]);
});

test("no devices lists none", () => {
  assert.deepEqual(parseDevices("List of devices attached\n"), []);
});

const base = { width: 540, bitrate: "4M", fps: 60, jpegQ: 4, codec: "h265", showTouches: false, stayAwake: false, audio: false, audioSource: "output", audioCodec: "opus", powerOffOnClose: false };

test("quality config defaults and clamps", () => {
  assert.deepEqual(qualityConfig({}), base);
  assert.deepEqual(qualityConfig({
    REX_SIM_WIDTH: "720", REX_SIM_BITRATE: "8M", REX_SIM_FPS: "30", REX_SIM_JPEG_Q: "2",
    REX_SIM_CODEC: "h264", REX_SIM_SHOW_TOUCHES: "1", REX_SIM_STAY_AWAKE: "1",
    REX_SIM_AUDIO: "1", REX_SIM_AUDIO_SOURCE: "mic", REX_SIM_AUDIO_CODEC: "aac",
  }),
    { ...base, width: 720, bitrate: "8M", fps: 30, jpegQ: 2, codec: "h264", showTouches: true, stayAwake: true, audio: true, audioSource: "mic", audioCodec: "aac" });
  assert.deepEqual(qualityConfig({ REX_SIM_WIDTH: "9999", REX_SIM_FPS: "0", REX_SIM_JPEG_Q: "99" }), base);
});

test("mjpeg parser joins frames across arbitrary chunk boundaries", () => {
  const a = jpeg(1);
  const b = jpeg(2);
  const stream = Buffer.concat([a, b]);
  const parser = new MjpegParser();
  const got = [];
  for (let i = 0; i < stream.length; i += 3) {
    parser.push(stream.subarray(i, i + 3));
    got.push(...parser.next());
  }
  assert.deepEqual(got, [a, b]);
  assert.deepEqual(parser.next(), []);
});

test("mjpeg parser drops garbage and waits for a whole frame", () => {
  const parser = new MjpegParser();
  parser.push(Buffer.from("garbage"));
  assert.deepEqual(parser.next(), []);
  const frame = jpeg(9);
  parser.push(frame.subarray(0, frame.length - 1));
  assert.deepEqual(parser.next(), []);
  parser.push(frame.subarray(frame.length - 1));
  assert.deepEqual(parser.next(), [frame]);
});

test("mjpeg parser does not mistake stuffed FF00 for the frame end", () => {
  const body = Buffer.from([0xff, 0x00, 0xff, 0x00, 0x01]);
  const frame = Buffer.concat([Buffer.from([0xff, 0xd8]), body, Buffer.from([0xff, 0xd9])]);
  const parser = new MjpegParser();
  parser.push(frame);
  assert.deepEqual(parser.next(), [frame]);
});
