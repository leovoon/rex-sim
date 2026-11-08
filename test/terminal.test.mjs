import assert from "node:assert/strict";
import { test } from "node:test";
import { InputParser } from "../src/terminal.mjs";

const parse = (...chunks) => {
  const parser = new InputParser();
  return chunks.flatMap((c) => [...parser.parse(Buffer.from(c))]);
};

test("mouse press, drag, release and wheel in pixels, 0-based", () => {
  assert.deepEqual(parse("\x1b[<0;101;51M\x1b[<32;111;61M\x1b[<0;111;61m\x1b[<65;5;6M\x1b[<64;5;6M"), [
    { type: "mouse", x: 100, y: 50, action: "press", button: 0 },
    { type: "mouse", x: 110, y: 60, action: "drag" },
    { type: "mouse", x: 110, y: 60, action: "release" },
    { type: "mouse", x: 4, y: 5, action: "wheel", dy: 1 },
    { type: "mouse", x: 4, y: 5, action: "wheel", dy: -1 },
  ]);
});

test("typed characters, control bytes and named keys", () => {
  assert.deepEqual(parse("hi\r\x03\x1b[A\x1b[3~\x1bOD\x1b[5~").map((e) => e.key), ["h", "i", "\r", "\x03", "up", "delete", "left", "pageup"]);
});

test("a lone Escape is a key", () => {
  assert.deepEqual(parse("\x1b"), [{ type: "key", key: "\x1b" }]);
});

test("rex-sim commands arrive as APC sequences, with an optional argument", () => {
  assert.deepEqual(parse("\x1b_rex-sim;home\x1b\\\x1b_rex-sim;device;avd:Pixel_3a_API_36\x1b\\"), [
    { type: "command", name: "home", arg: null },
    { type: "command", name: "device", arg: "avd:Pixel_3a_API_36" },
  ]);
});

test("sequences split across chunks are joined", () => {
  assert.deepEqual(parse("a\x1b[<0;10", ";20M", "\x1b_rex-sim;vol", "ume-up\x1b", "\\b"), [
    { type: "key", key: "a" },
    { type: "mouse", x: 9, y: 19, action: "press", button: 0 },
    { type: "command", name: "volume-up", arg: null },
    { type: "key", key: "b" },
  ]);
});

test("terminal replies: cell size, colors and graphics errors", () => {
  assert.deepEqual(parse("\x1b[6;28;14t\x1b]10;rgb:ffff/8080/0000\x1b\\\x1b]11;rgb:00/00/00\x07\x1b_Gi=1;ENOENT:no file\x1b\\"), [
    { type: "report", kind: 6, height: 28, width: 14 },
    { type: "color", slot: "foreground", rgb: [255, 128, 0] },
    { type: "color", slot: "background", rgb: [0, 0, 0] },
    { type: "graphics", reply: "i=1;ENOENT:no file" },
  ]);
});

test("Alt-letter does not swallow later input", () => {
  assert.deepEqual(parse("\x1bx", "y").map((e) => e.key), ["\x1b", "x", "y"]);
});
