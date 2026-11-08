import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { imageSize } from "../src/frames.mjs";

const image = (format) => sharp({ create: { width: 7, height: 13, channels: 3, background: "#123456" } })[format]().toBuffer();

test("image size of a PNG and a JPEG", async () => {
  assert.deepEqual(imageSize(await image("png")), { width: 7, height: 13 });
  assert.deepEqual(imageSize(await image("jpeg")), { width: 7, height: 13 });
});

test("no size for bytes that are neither", () => {
  assert.equal(imageSize(Buffer.from("not an image at all")), null);
});
