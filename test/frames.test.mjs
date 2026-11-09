import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { imageDisplaySize, imageSize } from "../src/frames.mjs";

const image = (format) => sharp({ create: { width: 7, height: 13, channels: 3, background: "#123456" } })[format]().toBuffer();

const u16 = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);

// A minimal JPEG with an optional JFIF APP0 segment and a SOF0 segment. The
// APP0 segment is emitted first unless `app0First` is false.
function jpeg(w, h, meta, app0First = true) {
  const app0 = meta && Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    u16(14 + 2),
    Buffer.from("JFIF\0"),
    Buffer.from([0x01, 0x01]),
    Buffer.from([meta.units ?? 0]),
    u16(meta.x ?? 1),
    u16(meta.y ?? 1),
    Buffer.from([0x00, 0x00]),
  ]);
  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    u16(15 + 2),
    Buffer.from([0x08]),
    u16(h),
    u16(w),
    Buffer.from([0x03]),
    Buffer.from([0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]),
  ]);
  const segments = [Buffer.from([0xff, 0xd8])];
  if (app0First) {
    if (app0) segments.push(app0);
    segments.push(sof);
  } else {
    segments.push(sof);
    if (app0) segments.push(app0);
  }
  segments.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(segments);
}

test("image size of a PNG and a JPEG", async () => {
  assert.deepEqual(imageSize(await image("png")), { width: 7, height: 13 });
  assert.deepEqual(imageSize(await image("jpeg")), { width: 7, height: 13 });
});

test("no size for bytes that are neither", () => {
  assert.equal(imageSize(Buffer.from("not an image at all")), null);
});

test("imageDisplaySize: PNG and JPEG without JFIF metadata stay square (null)", async () => {
  assert.equal(imageDisplaySize(await image("png")), null);
  assert.equal(imageDisplaySize(jpeg(240, 536)), null); // no APP0
  assert.equal(imageDisplaySize(Buffer.from("garbage")), null);
});

test("imageDisplaySize: JFIF unit-0 density ratio drives the display size", () => {
  // Portrait: square pixels -> coded size.
  assert.deepEqual(imageDisplaySize(jpeg(240, 536, { x: 1, y: 1 })), { width: 240, height: 536 });
  // Landscape: ffmpeg keeps coded 240x536 but sets X/Y densities 4489/900
  // (ratio 67:30) -> display width = 240 * 4489/900 ~= 1197.
  assert.deepEqual(imageDisplaySize(jpeg(240, 536, { x: 4489, y: 900 })), { width: 1197, height: 536 });
  // APP0 not first: scanning still finds both segments.
  assert.deepEqual(imageDisplaySize(jpeg(240, 536, { x: 4489, y: 900 }, false)), { width: 1197, height: 536 });
});

test("imageDisplaySize: absolute DPI (units 1) and malformed data fall back to square", () => {
  assert.equal(imageDisplaySize(jpeg(240, 536, { units: 1, x: 72, y: 72 })), null);
  assert.equal(imageDisplaySize(jpeg(240, 536, { x: 0, y: 0 })), null); // zero ratio
  const truncated = jpeg(240, 536, { x: 4489, y: 900 });
  assert.equal(imageDisplaySize(truncated.subarray(0, truncated.length - 3)), null);
  const bad = Buffer.from([0xff, 0xd8, 0xff, 0xff]);
  assert.equal(imageDisplaySize(bad), null);
});

test("imageDisplaySize leaves imageSize unchanged for the same bytes", () => {
  const landscape = jpeg(240, 536, { x: 4489, y: 900 });
  assert.deepEqual(imageSize(landscape), { width: 240, height: 536 }); // SOF preserved
  assert.deepEqual(imageDisplaySize(landscape), { width: 1197, height: 536 });
});

test("imageDisplaySize on real ffmpeg output honors non-square pixel aspect", async (t) => {
  const which = spawnSync("sh", ["-c", "command -v ffmpeg"]);
  if (which.status !== 0) {
    t.skip("ffmpeg not installed");
    return;
  }
  // A real MJPEG stream whose coded size stays 240x536 while the pixel
  // aspect makes the display ~67:30 (like a rotated session).
  const out = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=black:size=240x536:rate=25:duration=0.4",
    "-vf", "setsar=4489/900",
    "-frames:v", "3",
    "-f", "image2pipe", "-",
  ]);
  assert.equal(out.status, 0, out.stderr.toString());
  const frames = [];
  for (let i = 0; i + 1 < out.stdout.length; ) {
    if (out.stdout[i] === 0xff && out.stdout[i + 1] === 0xd8) {
      let j = i + 2;
      while (j + 1 < out.stdout.length && !(out.stdout[j] === 0xff && out.stdout[j + 1] === 0xd9)) j++;
      if (j + 1 < out.stdout.length) {
        frames.push(out.stdout.subarray(i, j + 2));
        i = j + 2;
        continue;
      }
    }
    i++;
  }
  assert.ok(frames.length >= 1, "no frames decoded from ffmpeg");
  for (const f of frames) {
    assert.deepEqual(imageSize(f), { width: 240, height: 536 }); // SOF fixed
    const d = imageDisplaySize(f);
    assert.ok(d, "real JPEG should yield a display size");
    assert.equal(d.height, 536);
    assert.ok(Math.abs(d.width / d.height - 67 / 30) < 0.15, `DAR ${d.width}/${d.height} should be ~67:30`);
  }
});

test("imageDisplaySize on a sharp JPEG with injected JFIF ratio", async () => {
  const base = await sharp({ create: { width: 240, height: 536, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  assert.deepEqual(imageSize(base), { width: 240, height: 536 });
  // Inject JFIF unit-0 density ratio 4489/900 after SOI (stripping any APP0).
  let rest = base.subarray(2);
  if (rest[0] === 0xff && rest[1] === 0xe0) {
    const len = rest.readUInt16BE(2);
    rest = rest.subarray(2 + len);
  }
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0]),
    u16(16),
    Buffer.from("JFIF\0"),
    Buffer.from([0x01, 0x01]),
    Buffer.from([0x00]),
    u16(4489),
    u16(900),
    Buffer.from([0x00, 0x00]),
  ]);
  const withRatio = Buffer.concat([base.subarray(0, 2), app0, rest]);
  assert.deepEqual(imageSize(withRatio), { width: 240, height: 536 });
  const d = imageDisplaySize(withRatio);
  assert.ok(d);
  assert.equal(d.height, 536);
  assert.ok(Math.abs(d.width / d.height - 67 / 30) < 0.15, `DAR ${d.width}/${d.height} should be ~67:30`);
});
