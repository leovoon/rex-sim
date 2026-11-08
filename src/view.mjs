import { PLATFORMS, canRepair } from "./devices.mjs";

const SGR = { dim: "2", green: "32", red: "31", reverse: "7" };

// One row of styled segments, cut to `width` cells. `base`, a style name or
// raw SGR parameters, styles the whole row, padded to the width.
function line(segments, width, base) {
  let s = "";
  let left = width;
  for (const [text, style] of segments) {
    if (left <= 0) break;
    const t = text.length > left ? `${text.slice(0, Math.max(0, left - 1))}…` : text;
    left -= t.length;
    s += `\x1b[${[0, base && (SGR[base] ?? base), style && SGR[style]].filter(Boolean).join(";")}m${t}`;
  }
  return `${s}${base ? " ".repeat(Math.max(0, left)) : ""}\x1b[0m`;
}

function wrap(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

// Where things go, in cells (1-based rows and columns) and in the terminal's
// pixels, which are the mouse's units: the status line on the last row, and
// above it the screen, as large as fits, centered.
export function layout({ cols, rows, cellWidth, cellHeight }, frame) {
  const area = { row: 1, rows: Math.max(0, rows - 1), x: 0, y: 0, width: cols * cellWidth, height: Math.max(0, rows - 1) * cellHeight };
  let screen = null;
  if (frame && area.rows > 0) {
    const scale = Math.min(area.width / frame.width, area.height / frame.height);
    const width = Math.max(1, Math.floor(frame.width * scale));
    const height = Math.max(1, Math.floor(frame.height * scale));
    const col = Math.floor((area.width - width) / 2 / cellWidth);
    const row = area.row + Math.floor((area.height - height) / 2 / cellHeight);
    screen = { row, col, x: col * cellWidth, y: (row - 1) * cellHeight, width, height };
  }
  return { cols, rows, cellWidth, cellHeight, area, screen };
}

// The view's text, for the area above the status line.
function message(view) {
  switch (view.kind) {
    case "empty": return "Press Ctrl-P to pick a device";
    case "connecting": return `Connecting to ${view.device.name}…`;
    case "booting": return `Booting ${view.device.name}…`;
    case "message":
    case "error": return view.text;
    case "streaming": return null;
  }
}

// The picker's rows: a heading per platform, its devices, then Repair input
// for a running device whose platform can repair. Rows with `select` can be picked.
export function pickerEntries(devices, current) {
  const entries = [];
  for (const platform of PLATFORMS) {
    const list = devices.filter((d) => d.platform === platform.id);
    if (list.length) entries.push({ segments: [[platform.label, "dim"]] });
    for (const d of list) {
      const os = d.unusable ? `${d.os} · ${d.unusable}` : d.os;
      entries.push({
        device: d,
        segments: [
          ["  "],
          d.booted ? ["● ", "green"] : ["  "],
          [d.name, d.unusable && "dim"],
          [`  ${os}`, "dim"],
          ...(d.id === current?.id ? [["  ✓"]] : []),
        ],
        select: d.unusable ? null : (actions) => actions.pick(d),
      });
    }
  }
  if (canRepair(current)) {
    entries.push({ segments: [] });
    entries.push({
      segments: [["  Repair input"], [" · restarts SpringBoard", "dim"]],
      select: (actions) => actions.repair(current),
    });
  }
  return entries;
}

// The selectable row `delta` steps from `cursor`, or `cursor` when there is none.
export function moveCursor(entries, cursor, delta) {
  for (let i = cursor + delta; i >= 0 && i < entries.length; i += delta) if (entries[i].select) return i;
  return cursor;
}

// A cursor on the current device, else on the first row that can be picked.
export function firstCursor(entries, current) {
  const i = entries.findIndex((e) => e.select && e.device?.id === current?.id);
  return i >= 0 ? i : moveCursor(entries, -1, 1);
}

export const fraction = (rect, e) => ({ x: (e.x - rect.x) / rect.width, y: (e.y - rect.y) / rect.height });

export const hit = (regions, e) => regions.find((r) => e.x >= r.x0 && e.x < r.x1 && e.y >= r.y0 && e.y < r.y1);

// state: { view, picker: null | { devices, cursor }, device (this pane's), notice,
//   selection (SGR parameters for the picker's current row) }
// -> the area's rows (null while the screen shows there), the status line,
// and the regions a click can hit, in pixels, each with `run(mouseEvent)`.
export function render(state, geometry, actions) {
  const { view, picker, device } = state;
  const { cols, cellWidth: cw, cellHeight: ch, area } = geometry;
  const regions = [];
  const streaming = view.kind === "streaming";

  let rows = null;
  let hints;
  if (picker) {
    const entries = pickerEntries(picker.devices, device);
    const offset = Math.max(0, Math.min(entries.length - area.rows, picker.cursor - Math.floor(area.rows / 2)));
    rows = entries.slice(offset, offset + area.rows).map((entry, i) => {
      const index = offset + i;
      if (entry.select) {
        const y0 = area.y + i * ch;
        regions.push({ x0: 0, y0, x1: area.width, y1: y0 + ch, run: (e) => (e.action === "wheel" ? actions.moveCursor(e.dy) : e.action === "press" && entry.select(actions)) });
      }
      return line([[" "], ...entry.segments], cols, index === picker.cursor ? state.selection ?? "reverse" : null);
    });
    if (!entries.length) rows = wrap("No simulators or emulators. Create one in Xcode or Android Studio.", cols - 2).map((t) => line([[` ${t}`, "dim"]], cols));
    regions.push({ x0: 0, y0: area.y, x1: area.width, y1: area.y + area.height, run: (e) => (e.action === "wheel" ? actions.moveCursor(e.dy) : e.action === "press" && actions.togglePicker()) });
    hints = "↑↓ move · enter pick · esc close";
  } else if (streaming) {
    const screen = geometry.screen;
    if (screen) {
      regions.push({
        x0: screen.x, y0: screen.y, x1: screen.x + screen.width, y1: screen.y + screen.height,
        run: (e) => {
          const p = fraction(screen, e);
          if (e.action === "wheel") actions.scroll(e.dy, p);
          else if (e.action === "press" && e.button === 0) actions.touch(p);
        },
      });
    }
    hints = "ctrl-p devices · ctrl-c quit";
  } else {
    const lines = wrap(message(view), Math.max(10, cols - 4));
    const top = Math.max(0, Math.floor((area.rows - lines.length) / 2));
    rows = Array.from({ length: Math.min(area.rows, top + lines.length) }, (_, i) => {
      const t = lines[i - top];
      return t ? line([[" ".repeat(Math.max(0, Math.floor((cols - t.length) / 2)))], [t, view.kind === "error" ? "red" : "dim"]], cols) : "";
    });
    hints = "ctrl-p devices · ctrl-c quit";
  }

  // The device on the status line, which opens the picker like Ctrl-P.
  const dot = streaming ? "green" : view.kind === "error" ? "red" : "dim";
  const label = device ? `${device.name} · ${device.os}` : "Select device";
  const statusY = (geometry.rows - 1) * ch;
  regions.push({ x0: 0, y0: statusY, x1: (label.length + 5) * cw, y1: statusY + ch, run: (e) => e.action === "press" && actions.togglePicker() });
  const status = line([[" "], ["●", dot], [` ${label} ▾`], [`   ${[hints, state.notice].filter(Boolean).join(" · ")}`, "dim"]], cols - 1);
  return { area: rows, status, regions };
}
