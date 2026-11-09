// The stream-settings menu's rows and their state. The menu owns no UI; the
// app renders it. All "current value" decisions here derive from the
// *effective* environment (through qualityConfig), never from a stale
// constant, so the menu shows what the stream will actually use.
import { qualityConfig } from "./physical.mjs";

export const SETTING_ROWS = [
  {
    key: "1", label: "presets", values: [
      { label: "smooth 360", env: { REX_SIM_WIDTH: "360", REX_SIM_FPS: "60", REX_SIM_BITRATE: "3M", REX_SIM_JPEG_Q: "6" } },
      { label: "balanced 540", env: { REX_SIM_WIDTH: "540", REX_SIM_FPS: "60", REX_SIM_BITRATE: "4M", REX_SIM_JPEG_Q: "4" } },
      { label: "sharp 720", env: { REX_SIM_WIDTH: "720", REX_SIM_FPS: "60", REX_SIM_BITRATE: "8M", REX_SIM_JPEG_Q: "3" } },
      { label: "max 1080", env: { REX_SIM_WIDTH: "1080", REX_SIM_FPS: "30", REX_SIM_BITRATE: "10M", REX_SIM_JPEG_Q: "2" } },
    ],
  },
  { key: "2", label: "codec", values: [
    { label: "h264", env: { REX_SIM_CODEC: "h264" } },
    { label: "h265", env: { REX_SIM_CODEC: "h265" } },
  ] },
  { key: "3", label: "width", values: [360, 540, 720, 1080].map((w) => ({ label: String(w), env: { REX_SIM_WIDTH: String(w) } })) },
  { key: "4", label: "fps", values: [15, 30, 60, 90].map((f) => ({ label: String(f), env: { REX_SIM_FPS: String(f) } })) },
  { key: "5", label: "bitrate", values: ["2M", "4M", "8M", "12M"].map((b) => ({ label: b, env: { REX_SIM_BITRATE: b } })) },
  { key: "6", label: "jpeg q", values: [8, 6, 4, 2].map((q) => ({ label: String(q), env: { REX_SIM_JPEG_Q: String(q) } })) },
  { key: "7", label: "show-touches", values: [
    { label: "off", env: { REX_SIM_SHOW_TOUCHES: "0" } },
    { label: "on", env: { REX_SIM_SHOW_TOUCHES: "1" } },
  ] },
  { key: "8", label: "stay-awake", values: [
    { label: "off", env: { REX_SIM_STAY_AWAKE: "0" } },
    { label: "on", env: { REX_SIM_STAY_AWAKE: "1" } },
  ] },
  { key: "9", label: "audio", values: [
    { label: "off", env: { REX_SIM_AUDIO: "0" } },
    { label: "on", env: { REX_SIM_AUDIO: "1" } },
  ] },
];

// Env var -> qualityConfig key + how to compare a menu value against the
// effective config (same semantics as qualityConfig: strings, numbers, and
// "1"/"0" booleans).
const QUALITY_KEY = {
  REX_SIM_WIDTH: { key: "width", type: "num" },
  REX_SIM_FPS: { key: "fps", type: "num" },
  REX_SIM_BITRATE: { key: "bitrate", type: "str" },
  REX_SIM_JPEG_Q: { key: "jpegQ", type: "num" },
  REX_SIM_CODEC: { key: "codec", type: "str" },
  REX_SIM_SHOW_TOUCHES: { key: "showTouches", type: "bool" },
  REX_SIM_STAY_AWAKE: { key: "stayAwake", type: "bool" },
  REX_SIM_AUDIO: { key: "audio", type: "bool" },
};

export function envMatchesEffective(env, eff) {
  return Object.entries(env).every(([name, value]) => {
    const spec = QUALITY_KEY[name];
    if (!spec) return false;
    const actual = eff[spec.key];
    if (spec.type === "bool") return Boolean(actual) === (value === "1");
    if (spec.type === "num") return Number(actual) === Number(value);
    return actual === value;
  });
}

// The index of the value matching the effective env, or -1 when the env
// holds a custom value outside the row's choices.
export function rowCurrent(row, eff) {
  return row.values.findIndex((v) => envMatchesEffective(v.env, eff));
}

// The label to show for a row: the matching choice, or the actual effective
// value when it is a custom value outside the row's choices.
export function rowLabel(row, eff) {
  const i = rowCurrent(row, eff);
  if (i >= 0) return row.values[i].label;
  if (row.key === "1") return "custom"; // a preset only matches wholesale
  const first = Object.keys(row.values[0].env)[0];
  return String(eff[QUALITY_KEY[first].key]);
}

// Staged edits are a chronological field-level overlay: every edit writes its
// env fields into the overlay, so the last write to a field wins no matter
// which row produced it. Rows are never assigned "current indices"; all
// labels and cycling derive exclusively from the overlay.
export function overlaidEnv(env, staged) {
  const out = { ...env };
  for (const [name, value] of staged) out[name] = value;
  return out;
}

// The fields whose staged value differs from the *effective* base (unset
// env fields count as their defaults, so staging the default is no change).
// Applying this is a no-op when edits cancelled out against the base.
export function netDiff(env, staged) {
  const eff = qualityConfig(env);
  const out = {};
  for (const [name, value] of staged) {
    if (!envMatchesEffective({ [name]: value }, eff)) out[name] = value;
  }
  return out;
}

export class SettingsMenu {
  constructor(env = process.env) {
    this.env = env;
    this.staged = new Map(); // field -> value (chronological overlay)
    this.cursor = 0;
  }

  rows() {
    return SETTING_ROWS;
  }

  baseEff() {
    return qualityConfig(this.env);
  }

  overlaidEff() {
    return qualityConfig(overlaidEnv(this.env, this.staged));
  }

  labelOf(row) {
    return rowLabel(row, this.overlaidEff());
  }

  // Net-effective changed indicator: a row changed when its displayed value
  // under the staged overlay differs from what the base env would display.
  changed(row) {
    return rowLabel(row, this.overlaidEff()) !== rowLabel(row, this.baseEff());
  }

  select(key) {
    const i = SETTING_ROWS.findIndex((r) => r.key === key);
    if (i < 0) return false;
    this.cursor = i;
    return true;
  }

  moveCursor(delta) {
    this.cursor = Math.min(SETTING_ROWS.length - 1, Math.max(0, this.cursor + delta));
  }

  cycle(delta) {
    const row = SETTING_ROWS[this.cursor];
    const current = rowCurrent(row, this.overlaidEff());
    const len = row.values.length;
    const next = current < 0 ? (delta > 0 ? 0 : len - 1) : (current + delta + len) % len;
    for (const [name, value] of Object.entries(row.values[next].env)) this.staged.set(name, value);
  }

  diff() {
    return netDiff(this.env, this.staged);
  }

  // Writes only the net-changed fields into this.env. Returns whether any
  // field actually changed (false = cancellations net-equal the base).
  apply() {
    const diff = netDiff(this.env, this.staged);
    for (const [name, value] of Object.entries(diff)) this.env[name] = value;
    this.staged.clear();
    return Object.keys(diff).length > 0;
  }

  discard() {
    this.staged.clear();
  }
}
