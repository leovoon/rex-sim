import assert from "node:assert/strict";
import { test } from "node:test";
import { hit, layout, render } from "../src/view.mjs";

const metrics = { cols: 40, rows: 30, cellWidth: 14, cellHeight: 28 };
const iphone = { platform: "ios", id: "B", name: "iPhone 17", os: "iOS 27.2", booted: true };
const pixel = { platform: "android", id: "avd:P", avd: "P", name: "Pixel", os: "Android API 36", booted: false, unusable: null };
const old = { platform: "android", id: "avd:X", avd: "X", name: "Old", os: "Android API 30", booted: false, unusable: "x86_64 image, can't run on this Mac" };
const iosInput = { touch() {}, scroll() {}, key() {}, button() {}, volume() {}, rotate() {}, softwareKeyboard() {} };
const { softwareKeyboard, ...androidInput } = iosInput;

function recorder() {
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  return { calls, actions };
}

const streaming = (device, input) => ({ view: { kind: "streaming", session: { device, input } }, picker: null, device, fps: 30 });
const press = (x, y) => ({ type: "mouse", action: "press", button: 0, x, y });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the screen fits between the header and the status line, centered, aspect kept", () => {
  const frame = layout(metrics, { width: 1206, height: 2622 });
  const { screen } = frame;
  assert.equal(screen.y, 28);
  assert.equal(screen.height, 28 * 28);
  assert.equal(screen.width, Math.floor(1206 * (784 / 2622)));
  assert.equal(screen.col, Math.floor((40 * 14 - screen.width) / 2 / 14));
  assert.equal(screen.x, screen.col * 14);
  const wide = layout(metrics, { width: 2622, height: 1206 }).screen;
  assert.equal(wide.width, 560);
  assert.ok(wide.row > 2, "a landscape screen is centered vertically");
});

test("a click on the screen taps at that fraction of it; the wheel scrolls there", () => {
  const frame = layout(metrics, { width: 1206, height: 2622 });
  const { calls, actions } = recorder();
  const { regions } = render(streaming(iphone, iosInput), frame, actions);
  const s = frame.screen;
  hit(regions, press(s.x + s.width / 2, s.y + s.height / 4)).run(press(s.x + s.width / 2, s.y + s.height / 4));
  const wheel = { type: "mouse", action: "wheel", dy: 1, x: s.x, y: s.y + s.height / 2 };
  hit(regions, wheel).run(wheel);
  assert.deepEqual(calls, [["touch", { x: 0.5, y: 0.25 }], ["scroll", 1, { x: 0, y: 0.5 }]]);
});

test("the toolbar has a button per command the device takes; iOS has a keyboard, Android not", () => {
  const frame = layout(metrics, { width: 1206, height: 2622 });
  const pressAll = (state) => {
    const { calls, actions } = recorder();
    for (let x = 0; x < 40 * 14; x += 7) {
      hit(render(state, frame, actions).regions, press(x, 10))?.run(press(x, 10));
    }
    return [...new Set(calls.filter(([n]) => n === "command").map(([, c]) => c))];
  };
  assert.deepEqual(pressAll(streaming(iphone, iosInput)), ["home", "lock", "volume-down", "volume-up", "rotate", "keyboard"]);
  assert.deepEqual(pressAll(streaming(pixel, androidInput)), ["home", "lock", "volume-down", "volume-up", "rotate"]);
});

test("the header names the device and opens the picker", () => {
  const frame = layout(metrics, null);
  const { calls, actions } = recorder();
  const out = render({ view: { kind: "connecting", device: iphone }, picker: null, device: iphone, fps: 0 }, frame, actions);
  assert.match(strip(out.header), /iPhone 17 · iOS 27\.2 ▾/);
  assert.ok(strip(out.area.join("\n")).includes("Connecting to iPhone 17…"));
  hit(out.regions, press(20, 10)).run(press(20, 10));
  assert.deepEqual(calls, [["togglePicker"]]);
  const none = render({ view: { kind: "empty" }, picker: null, device: null, fps: 0 }, frame, actions);
  assert.match(strip(none.header), /Select device ▾/);
  assert.ok(strip(none.area.join("\n")).includes("Pick a device above"));
});

test("the picker lists Android then iOS; clicking a row picks it, unusable rows can't be picked", () => {
  const frame = layout(metrics, null);
  const { calls, actions } = recorder();
  const state = { view: { kind: "empty" }, picker: { devices: [iphone, pixel, old], cursor: 4 }, device: iphone, fps: 0 };
  const out = render(state, frame, actions);
  const rows = out.area.map(strip).map((r) => r.trim());
  assert.deepEqual(rows.slice(0, 5), ["Android", "Pixel  Android API 36", "Old  Android API 30 · x86_64 image…", "iOS", "● iPhone 17  iOS 27.2  ✓"]);
  assert.equal(rows[6], "Repair input · restarts SpringBoard");
  const rowY = (i) => 28 + i * 28 + 5;
  for (const i of [1, 2, 4, 6]) hit(out.regions, press(30, rowY(i))).run(press(30, rowY(i)));
  assert.deepEqual(calls.map(([n, d]) => [n, d?.id]), [["pick", "avd:P"], ["togglePicker", undefined], ["pick", "B"], ["repair", "B"]]);
});
