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

const streaming = (device, input) => ({ view: { kind: "streaming", session: { device, input } }, picker: null, device });
const press = (x, y) => ({ type: "mouse", action: "press", button: 0, x, y });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the screen fits above the status line, centered, aspect kept", () => {
  const geometry = layout(metrics, { width: 1206, height: 2622 });
  const { screen } = geometry;
  assert.equal(screen.y, 0);
  assert.equal(screen.height, 29 * 28);
  assert.equal(screen.width, Math.floor(1206 * (812 / 2622)));
  assert.equal(screen.col, Math.floor((40 * 14 - screen.width) / 2 / 14));
  assert.equal(screen.x, screen.col * 14);
  const wide = layout(metrics, { width: 2622, height: 1206 }).screen;
  assert.equal(wide.width, 560);
  assert.ok(wide.row > 1, "a landscape screen is centered vertically");
});

test("a click on the screen taps at that fraction of it; the wheel scrolls there", () => {
  const geometry = layout(metrics, { width: 1206, height: 2622 });
  const { calls, actions } = recorder();
  const { regions } = render(streaming(iphone, iosInput), geometry, actions);
  const s = geometry.screen;
  hit(regions, press(s.x + s.width / 2, s.y + s.height / 4)).run(press(s.x + s.width / 2, s.y + s.height / 4));
  const wheel = { type: "mouse", action: "wheel", dy: 1, x: s.x, y: s.y + s.height / 2 };
  hit(regions, wheel).run(wheel);
  assert.deepEqual(calls, [["touch", { x: 0.5, y: 0.25 }], ["scroll", 1, { x: 0, y: 0.5 }]]);
});

test("the status line names the device and opens the picker", () => {
  const geometry = layout(metrics, null);
  const statusY = 29 * 28 + 10;
  const { calls, actions } = recorder();
  const out = render({ view: { kind: "connecting", device: iphone }, picker: null, device: iphone }, geometry, actions);
  assert.match(strip(out.status), /iPhone 17 · iOS 27\.2 ▾/);
  assert.ok(strip(out.area.join("\n")).includes("Connecting to iPhone 17…"));
  hit(out.regions, press(20, statusY)).run(press(20, statusY));
  assert.deepEqual(calls, [["togglePicker"]]);
  const none = render({ view: { kind: "empty" }, picker: null, device: null }, geometry, actions);
  assert.match(strip(none.status), /Select device ▾/);
  assert.ok(strip(none.area.join("\n")).includes("Press Ctrl-P to pick a device"));
});

test("the picker lists Android then iOS; clicking a row picks it, unusable rows can't be picked", () => {
  const geometry = layout(metrics, null);
  const { calls, actions } = recorder();
  const state = { view: { kind: "empty" }, picker: { devices: [iphone, pixel, old], cursor: 4 }, device: iphone };
  const out = render(state, geometry, actions);
  const rows = out.area.map(strip).map((r) => r.trim());
  assert.deepEqual(rows.slice(0, 5), ["Android", "Pixel  Android API 36", "Old  Android API 30 · x86_64 image…", "iOS", "● iPhone 17  iOS 27.2  ✓"]);
  assert.equal(rows[6], "Repair input · restarts SpringBoard");
  const rowY = (i) => geometry.area.y + i * 28 + 5;
  for (const i of [1, 2, 4, 6]) hit(out.regions, press(30, rowY(i))).run(press(30, rowY(i)));
  assert.deepEqual(calls.map(([n, d]) => [n, d?.id]), [["pick", "avd:P"], ["togglePicker", undefined], ["pick", "B"], ["repair", "B"]]);
});
