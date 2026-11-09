import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION, backOrScreenOnMsg, keyMsg, rotateMsg, scrollMsg, textMsg, touchMsg, uhidCreateMsg, uhidInputMsg, UHID_DESCRIPTOR } from "../src/scrcpy-control.mjs";

test("key message: type, action, keycode, repeat, metastate", () => {
  const b = keyMsg(ACTION.DOWN, 66, 2, 1);
  assert.equal(b.length, 14);
  assert.deepEqual([...b], [0, 0, 0, 0, 0, 66, 0, 0, 0, 2, 0, 0, 0, 1]);
  assert.equal(b[0], 0);           // INJECT_KEYCODE
  assert.equal(b[1], 0);           // action down
  assert.equal(b.readInt32BE(2), 66);   // keycode ENTER
  assert.equal(b.readInt32BE(6), 2);    // repeat
  assert.equal(b.readInt32BE(10), 1);   // metastate shift
});

test("text message: type, length, utf8", () => {
  const b = textMsg("hi");
  assert.equal(b.length, 7);
  assert.equal(b[0], 1);
  assert.equal(b.readInt32BE(1), 2);
  assert.equal(b.toString("utf8", 5), "hi");
});

test("touch message: 32 bytes, position and pressure", () => {
  const b = touchMsg(ACTION.MOVE, 7, 100, 200, 1080, 2376, 1, 0, 1);
  assert.equal(b.length, 32);
  assert.equal(b[0], 2);
  assert.equal(b[1], 2);                 // move
  assert.equal(b.readBigInt64BE(2), 7n); // pointer id
  assert.equal(b.readInt32BE(10), 100);
  assert.equal(b.readInt32BE(14), 200);
  assert.equal(b.readUInt16BE(18), 1080);
  assert.equal(b.readUInt16BE(20), 2376);
  assert.equal(b.readUInt16BE(22), 0xffff); // pressure 1.0
  assert.equal(b.readInt32BE(24), 0);
  assert.equal(b.readInt32BE(28), 1);
});

test("scroll message: 21 bytes, fixed-point vscroll", () => {
  const b = scrollMsg(10, 20, 1080, 2376, 0, -0.5);
  assert.equal(b.length, 21);
  assert.equal(b[0], 3);
  assert.equal(b.readInt32BE(1), 10);
  assert.equal(b.readInt32BE(5), 20);
  assert.equal(b.readInt16BE(13), 0);
  assert.equal(b.readInt16BE(15), Math.round(-0.5 * 0x7fff));
  assert.equal(b.readInt32BE(17), 0);
});

test("empty and simple messages", () => {
  assert.deepEqual([...rotateMsg()], [11]);
  assert.deepEqual([...backOrScreenOnMsg(1)], [4, 1]);
});

test("uhid create message carries name and descriptor", () => {
  const b = uhidCreateMsg(1, 0x18d1, 0x0001, "rex-sim", UHID_DESCRIPTOR);
  assert.equal(b[0], 12);
  assert.equal(b.readUInt16BE(1), 1);
  assert.equal(b.readUInt16BE(3), 0x18d1);
  assert.equal(b[7], 7); // name length
  assert.equal(b.toString("utf8", 8, 15), "rex-sim");
  assert.equal(b.readUInt16BE(15), UHID_DESCRIPTOR.length);
  assert.deepEqual(b.subarray(17), UHID_DESCRIPTOR);
});

test("uhid input message frames a report", () => {
  const b = uhidInputMsg(1, Buffer.from([2, 0, 4, 0, 0, 0, 0, 0]));
  assert.equal(b.length, 13);
  assert.equal(b[0], 13);
  assert.equal(b.readUInt16BE(1), 1);
  assert.equal(b.readUInt16BE(3), 8);
  assert.equal(b[5], 2);
  assert.equal(b[7], 4);
});
