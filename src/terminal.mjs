import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const ESC = "\x1b";
const out = process.stdout;

// Mouse: button-event tracking (drags), SGR encoding, pixel coordinates.
const MOUSE_ON = `${ESC}[?1002h${ESC}[?1006h${ESC}[?1016h`;
const MOUSE_OFF = `${ESC}[?1016l${ESC}[?1006l${ESC}[?1002l`;
const DELETE_ALL = `${ESC}_Ga=d,d=A,q=2${ESC}\\`;

export function enter() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J${MOUSE_ON}`);
}

export function leave() {
  out.write(`${DELETE_ALL}${MOUSE_OFF}${ESC}[?25h${ESC}[?1049l`);
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

// Asks for the default colors and the cell size in pixels.
export function requestMetrics() {
  out.write(`${ESC}]10;?${ESC}\\${ESC}]11;?${ESC}\\${ESC}[16t`);
}

const NAMED = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE = { 1: "home", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };
// What a chunk may end with partway through a sequence.
const PARTIAL = /^\x1b(?:\[[0-9;?<>=]*[ -/]*|_[^\x1b]*\x1b?|\][^\x07\x1b]*\x1b?|O)?$/;

function mouse(code, x, y, release) {
  const at = { type: "mouse", x: x - 1, y: y - 1 };
  if (code & 64) return { ...at, action: "wheel", dy: code & 1 ? 1 : -1 };
  if (release) return { ...at, action: "release" };
  if (code & 32) return { ...at, action: "drag" };
  return { ...at, action: "press", button: code & 3 };
}

// Turns stdin bytes into events. Keeps a partial escape sequence for the next chunk.
export class InputParser {
  rest = "";

  *parse(chunk) {
    let s = this.rest + chunk.toString("utf8");
    this.rest = "";
    if (s === ESC) return yield { type: "key", key: ESC };
    let m;
    while (s.length) {
      if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s))) {
        yield mouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m");
      } else if ((m = /^\x1b_([^\x1b]*)\x1b\\/.exec(s))) {
        const body = m[1];
        if (body.startsWith("G")) yield { type: "graphics", reply: body.slice(1) };
        else if (body.startsWith("rex-sim;")) {
          const [name, ...arg] = body.slice(8).split(";");
          yield { type: "command", name, arg: arg.length ? arg.join(";") : null };
        }
      } else if ((m = /^\x1b\](1[01]);rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i.exec(s))) {
        const rgb = m.slice(2, 5).map((h) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255));
        yield { type: "color", slot: m[1] === "10" ? "foreground" : "background", rgb };
      } else if ((m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s))) {
        // Another reply we don't use.
      } else if ((m = /^\x1b\[(\d+);(\d+);(\d+)t/.exec(s))) {
        yield { type: "report", kind: Number(m[1]), height: Number(m[2]), width: Number(m[3]) };
      } else if ((m = /^\x1b[[O](?:1;\d+)?([ABCDHF])/.exec(s))) {
        yield { type: "key", key: NAMED[m[1]] };
      } else if ((m = /^\x1b\[(\d)~/.exec(s)) && TILDE[m[1]]) {
        yield { type: "key", key: TILDE[m[1]] };
      } else if ((m = /^\x1b\[[0-9;?<>=]*[ -/]*[@-~]/.exec(s))) {
        // Another report or key we don't use.
      } else if (PARTIAL.test(s)) {
        this.rest = s;
        return;
      } else {
        m = [s[0]];
        yield { type: "key", key: s[0] };
      }
      s = s.slice(m[0].length);
    }
  }
}

// The Kitty graphics protocol: one image per id, placed at the cursor without
// moving it.
function graphics(keys, payload = "") {
  return `${ESC}_G${keys}${payload && ";"}${payload}${ESC}\\`;
}

function inline(keys, data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 4096) {
    const more = i + 4096 < data.length ? 1 : 0;
    parts.push(graphics(i ? `m=${more}` : `${keys},m=${more}`, data.slice(i, i + 4096)));
  }
  return parts.join("");
}

const at = (row, col) => `${ESC}[${row};${col}H`;
const FRAME_IDS = [1, 2];
const ICON_ID = 10;

// What the pane shows: the device screen, alternating two image ids and
// deleting the old one after placing the new, so it never goes blank between
// frames; and the text around it, written only when it changes.
export class Screen {
  frame = 0;
  // "file": the terminal reads a temp file, no base64; "direct": bytes inline.
  medium = "file";
  shown = { header: null, area: null, status: null, frames: false, icons: 0 };

  async drawFrame(pixels, rect) {
    const id = FRAME_IDS[this.frame % 2];
    const old = FRAME_IDS[(this.frame + 1) % 2];
    const keys = `a=T,f=32,s=${rect.width},v=${rect.height},i=${id},p=1,C=1,q=1`;
    let image;
    if (this.medium === "file") {
      // The name must say what it is, and it must sit in a temp folder.
      const path = `/tmp/tty-graphics-protocol-rex-sim-${process.pid}-${this.frame}.rgba`;
      await writeFile(path, pixels);
      image = graphics(`${keys},t=t`, Buffer.from(path).toString("base64"));
    } else {
      image = inline(`${keys},o=z`, deflateSync(pixels, { level: 1 }).toString("base64"));
    }
    this.frame++;
    this.shown.frames = true;
    await write(`${at(rect.row, rect.col + 1)}${image}${graphics(`a=d,d=I,i=${old},q=2`)}`);
  }

  clearFrames() {
    if (!this.shown.frames) return;
    this.shown.frames = false;
    out.write(FRAME_IDS.map((id) => graphics(`a=d,d=I,i=${id},q=2`)).join(""));
  }

  // chrome: { header, icons: [{ col, key, png }], area: string[] | null, status },
  // with `area` null while the screen shows there.
  drawChrome(chrome, layout) {
    const { header, icons, area, status } = chrome;
    let s = "";
    const headerKey = header + icons.map((i) => `${i.col}:${i.key}`).join();
    if (headerKey !== this.shown.header) {
      this.shown.header = headerKey;
      s += `${at(1, 1)}${ESC}[2K${header}`;
      for (let i = 0; i < this.shown.icons; i++) s += graphics(`a=d,d=I,i=${ICON_ID + i},q=2`);
      this.shown.icons = icons.length;
      icons.forEach((icon, i) => {
        s += at(1, icon.col + 1) + inline(`a=T,f=100,i=${ICON_ID + i},p=1,C=1,q=2`, icon.png.toString("base64"));
      });
    }
    const areaKey = area ? area.join("\n") : "";
    if (areaKey !== this.shown.area) {
      this.shown.area = areaKey;
      if (area) this.clearFrames();
      for (let row = layout.area.row; row < layout.area.row + layout.area.rows; row++) {
        s += `${at(row, 1)}${ESC}[2K${area?.[row - layout.area.row] ?? ""}`;
      }
    }
    if (status !== this.shown.status) {
      this.shown.status = status;
      s += `${at(layout.rows, 1)}${ESC}[2K${status}`;
    }
    if (s) out.write(s);
  }

  // Everything, as after a resize.
  reset() {
    this.shown = { header: null, area: null, status: null, frames: false, icons: 0 };
    out.write(`${DELETE_ALL}${ESC}[2J`);
  }
}

async function write(s) {
  if (!out.write(s)) await new Promise((resolve) => out.once("drain", resolve));
}
