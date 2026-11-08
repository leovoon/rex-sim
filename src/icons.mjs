import { readFile } from "node:fs/promises";
import sharp from "sharp";

const DIR = new URL("../icons/", import.meta.url);

// A Lucide icon as a PNG `width` x `height` pixels, the icon centered at about
// three quarters of the height, stroked in `color` ("#rrggbb").
export async function iconPng(name, width, height, color) {
  const svg = await readFile(new URL(`${name}.svg`, DIR), "utf8");
  const side = Math.round(height * 0.78);
  const inner = svg
    .replace(/width="24" height="24"/, `x="${Math.round((width - side) / 2)}" y="${Math.round((height - side) / 2)}" width="${side}" height="${side}"`)
    .replaceAll("currentColor", color);
  const outer = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${inner}</svg>`;
  return sharp(Buffer.from(outer)).png().toBuffer();
}
