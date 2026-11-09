import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsMenu, SETTING_ROWS, netDiff, rowCurrent, rowLabel } from "../src/settings.mjs";

const row = (key) => SETTING_ROWS.find((r) => r.key === key);
const env = (obj) => ({ ...obj });

// Drive a row to a target label by cycling (handles rows whose overlay state
// is custom, where relative counts are not predictable).
function cycleTo(menu, key, label) {
  menu.select(key);
  const r = row(key);
  for (let i = 0; i < r.values.length && menu.labelOf(r) !== label; i++) menu.cycle(1);
  assert.equal(menu.labelOf(r), label, `${key} should reach ${label}`);
}

test("menu shows effective values, not stale constants", () => {
  const menu = new SettingsMenu(env({}));
  assert.equal(menu.labelOf(row("4")), "60"); // fps default 60 (not 90)
  assert.equal(menu.labelOf(row("6")), "4"); // jpeg q default 4 (not 6)
  assert.equal(menu.labelOf(row("9")), "off");
  assert.equal(menu.labelOf(row("1")), "balanced 540");
  assert.equal(menu.changed(row("9")), false);
});

test("custom env values display their actual value and cycle sanely", () => {
  const menu = new SettingsMenu(env({ REX_SIM_WIDTH: "400" }));
  assert.equal(menu.labelOf(row("3")), "400");
  assert.equal(menu.labelOf(row("1")), "custom");
  menu.select("3");
  menu.cycle(1); // custom -> first choice 360
  assert.equal(menu.labelOf(row("3")), "360");
  assert.deepEqual(menu.diff(), { REX_SIM_WIDTH: "360" });
  assert.equal(menu.apply(), true);
  assert.equal(menu.env.REX_SIM_WIDTH, "360");
  assert.equal(Object.keys(menu.env).length, 1); // only the net field written
});

test("chronological edits: last write to a field wins across rows", () => {
  const menu = new SettingsMenu(env({}));
  cycleTo(menu, "3", "360"); // width -> 360 (staged before the preset)
  cycleTo(menu, "1", "max 1080"); // preset overwrites width staged before
  assert.equal(menu.labelOf(row("3")), "1080");
  assert.equal(menu.labelOf(row("4")), "30");
  cycleTo(menu, "3", "360"); // last width edit wins
  assert.equal(menu.labelOf(row("1")), "custom"); // preset no longer matches
  assert.deepEqual(menu.diff(), {
    REX_SIM_WIDTH: "360",
    REX_SIM_FPS: "30",
    REX_SIM_BITRATE: "10M",
    REX_SIM_JPEG_Q: "2",
  });
});

test("a later row override makes the preset row show custom", () => {
  const menu = new SettingsMenu(env({}));
  cycleTo(menu, "1", "sharp 720");
  cycleTo(menu, "3", "540"); // overrides the preset's width
  assert.equal(menu.labelOf(row("1")), "custom");
  assert.equal(menu.changed(row("1")), true);
  assert.equal(menu.changed(row("3")), false); // width is back to its default
});

test("cancellations across preset and rows net-equal the base => no restart, no writes", () => {
  const menu = new SettingsMenu(env({}));
  cycleTo(menu, "1", "max 1080"); // width1080 fps30 b10M q2
  cycleTo(menu, "3", "540");
  cycleTo(menu, "4", "60");
  cycleTo(menu, "5", "4M");
  cycleTo(menu, "6", "4");
  assert.deepEqual(menu.diff(), {});
  assert.equal(menu.apply(), false);
  assert.deepEqual(menu.env, {});
});

test("mixed row diff writes only net-changed env fields", () => {
  const menu = new SettingsMenu(env({ REX_SIM_FPS: "60" }));
  menu.select("3");
  menu.cycle(-1); // width -> 360
  menu.select("9");
  menu.cycle(1); // audio -> on
  assert.deepEqual(menu.diff(), { REX_SIM_WIDTH: "360", REX_SIM_AUDIO: "1" });
  assert.equal(menu.apply(), true);
  assert.deepEqual(menu.env, { REX_SIM_FPS: "60", REX_SIM_WIDTH: "360", REX_SIM_AUDIO: "1" });
  assert.deepEqual(menu.diff(), {}); // now matches its own env
});

test("cycling after a preset starts from the effective overlay, not a cached index", () => {
  const menu = new SettingsMenu(env({}));
  menu.select("1");
  menu.cycle(2); // max 1080 (width 1080)
  menu.select("3");
  menu.cycle(-1); // width 1080 -> 720 (not 540, which cached index 1 would give)
  assert.equal(menu.labelOf(row("3")), "720");
});

test("escape discards staged edits without writing env", () => {
  const menu = new SettingsMenu(env({}));
  menu.select("9");
  menu.cycle(1);
  assert.deepEqual(menu.diff(), { REX_SIM_AUDIO: "1" });
  menu.discard();
  assert.deepEqual(menu.diff(), {});
  assert.equal(menu.apply(), false);
  assert.deepEqual(menu.env, {});
});

test("changed indicator reflects net effective state, not mere edits", () => {
  const menu = new SettingsMenu(env({}));
  assert.equal(menu.changed(row("9")), false);
  cycleTo(menu, "9", "on");
  assert.equal(menu.changed(row("9")), true);
  assert.equal(menu.changed(row("3")), false);
  cycleTo(menu, "9", "off"); // audio back to off
  assert.equal(menu.changed(row("9")), false);
  assert.deepEqual(menu.diff(), {});
});

test("digits select a row; arrows move the cursor", () => {
  const menu = new SettingsMenu(env({}));
  assert.equal(menu.select("7"), true);
  assert.equal(menu.cursor, 6);
  assert.equal(menu.select("0"), false);
  menu.moveCursor(-1);
  assert.equal(menu.cursor, 5);
  menu.moveCursor(1);
  assert.equal(menu.cursor, 6);
});

test("cycling wraps at the ends", () => {
  const menu = new SettingsMenu(env({}));
  menu.select("9");
  menu.cycle(-1); // off -> on
  assert.equal(menu.labelOf(row("9")), "on");
  menu.cycle(1); // on -> off
  assert.equal(menu.labelOf(row("9")), "off");
});

test("no preset duplicates another preset's env", () => {
  const presets = row("1").values.map((v) => JSON.stringify(v.env));
  assert.equal(new Set(presets).size, presets.length);
});

test("row helpers agree with the menu on defaults and custom state", () => {
  const eff = { width: 540, bitrate: "4M", fps: 60, jpegQ: 4, codec: "h265", showTouches: false, stayAwake: false, audio: false, audioSource: "output", audioCodec: "opus", powerOffOnClose: false };
  assert.equal(rowCurrent(row("4"), eff), 2); // 60
  assert.equal(rowCurrent(row("9"), eff), 0); // off
  assert.equal(rowLabel(row("1"), eff), "balanced 540");
  assert.equal(rowLabel(row("3"), { ...eff, width: 400 }), "400");
  assert.equal(rowCurrent(row("3"), { ...eff, width: 400 }), -1);
  assert.deepEqual(netDiff({}, new Map([["REX_SIM_WIDTH", "360"]])), { REX_SIM_WIDTH: "360" });
  assert.deepEqual(netDiff({ REX_SIM_WIDTH: "360" }, new Map([["REX_SIM_WIDTH", "360"]])), {});
});
