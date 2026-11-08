import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const ESC = "\x1b";
const out = process.stdout;

// Mouse: button-event tracking (drags), SGR encoding, pixel coordinates.
const MOUSE_ON = `${ESC}[?1002h${ESC}[?1006h${ESC}[?1016h`;
const MOUSE_OFF = `${ESC}[?1016l${ESC}[?1006l${ESC}[?1002l`;

export function enter() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J${MOUSE_ON}`);
}

export function leave() {
  out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${MOUSE_OFF}${ESC}[?25h${ESC}[?1049l`);
  process.stdin.setRawMode(false);
  process.stdin.pause();
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
        yield { type: "mouse", code: Number(m[1]), x: Number(m[2]) - 1, y: Number(m[3]) - 1, release: m[4] === "m" };
      } else if ((m = /^\x1b_G([^\x1b]*)\x1b\\/.exec(s))) {
        yield { type: "graphics", reply: m[1] };
      } else if ((m = /^\x1b\[(\d+);(\d+);(\d+)t/.exec(s))) {
        yield { type: "report", kind: Number(m[1]), height: Number(m[2]), width: Number(m[3]) };
      } else if ((m = /^\x1b[\[O]([ABCD])/.exec(s))) {
        yield { type: "key", key: { A: "up", B: "down", C: "right", D: "left" }[m[1]] };
      } else if ((m = /^\x1b\[3~/.exec(s))) {
        yield { type: "key", key: "delete" };
      } else if ((m = /^\x1b\[[0-9;?<>=]*[ -/]*[@-~]/.exec(s))) {
        // Another report we don't use.
      } else if (s[0] === ESC && s.length < 64) {
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

// Asks for the cell size and the text area, both in pixels.
export function requestMetrics() {
  out.write(`${ESC}[16t${ESC}[14t`);
}

// Where the screen goes: as large as fits above the status line, centered,
// in the terminal's pixels so one image pixel is one screen pixel.
export function fit(metrics, device) {
  const { cellWidth, cellHeight } = metrics;
  const cols = out.columns;
  const rows = out.rows - 1;
  const scale = Math.min((cols * cellWidth) / device.width, (rows * cellHeight) / device.height);
  const width = Math.max(1, Math.floor(device.width * scale));
  const height = Math.max(1, Math.floor(device.height * scale));
  const col = Math.floor((cols * cellWidth - width) / 2 / cellWidth);
  return { width, height, col, x: col * cellWidth, y: 0, rows: out.rows };
}

// Draws raw RGB pixels. Alternates two image ids and deletes the old one
// after placing the new, so the pane never shows an empty frame between them.
export class Screen {
  frame = 0;
  // "file": the terminal reads a temp file, no base64; "direct": bytes inline.
  medium = "file";

  async draw(pixels, layout, status) {
    const id = 1 + (this.frame % 2);
    const old = 1 + ((this.frame + 1) % 2);
    const head = `a=T,f=24,s=${layout.width},v=${layout.height},i=${id},p=1,C=1,q=1`;
    let image;
    if (this.medium === "file") {
      // The name must say what it is, and it must sit in a temp folder.
      const path = `/tmp/tty-graphics-protocol-rex-sim-${process.pid}-${this.frame}.rgb`;
      await writeFile(path, pixels);
      image = `${ESC}_G${head},t=t;${Buffer.from(path).toString("base64")}${ESC}\\`;
    } else {
      const data = deflateSync(pixels, { level: 1 }).toString("base64");
      const parts = [];
      for (let i = 0; i < data.length; i += 4096) {
        const more = i + 4096 < data.length ? 1 : 0;
        parts.push(`${ESC}_G${i ? "" : `${head},o=z,`}m=${more};${data.slice(i, i + 4096)}${ESC}\\`);
      }
      image = parts.join("");
    }
    this.frame++;
    const ok = out.write(
      `${ESC}[1;${layout.col + 1}H${image}${ESC}_Ga=d,d=I,i=${old},q=2${ESC}\\` +
        `${ESC}[${layout.rows};1H${ESC}[2K${status}`,
    );
    if (!ok) await new Promise((resolve) => out.once("drain", resolve));
  }

  clear() {
    out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\${ESC}[2J`);
  }
}
