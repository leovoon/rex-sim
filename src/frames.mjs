// Frames from a multipart/x-mixed-replace stream, as they arrive. Ends quietly
// when `signal` aborts.
export async function* multipartFrames(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    let buf = Buffer.alloc(0);
    for await (const chunk of res.body) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      for (;;) {
        const headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd < 0) break;
        const length = /content-length:\s*(\d+)/i.exec(buf.toString("latin1", 0, headEnd));
        if (!length) {
          buf = buf.subarray(headEnd + 4);
          continue;
        }
        const start = headEnd + 4;
        const end = start + Number(length[1]);
        if (buf.length < end) break;
        yield buf.subarray(start, end);
        buf = buf.subarray(end);
      }
    }
  } catch (e) {
    if (!signal.aborted) throw e;
  }
}

// Width and height from a PNG's IHDR or a JPEG's start-of-frame, or null.
export function imageSize(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

// Display dimensions for a JPEG frame: ffmpeg can encode a rotated video as
// NON-SQUARE pixels (SOF still holds the coded size, while JPEG APP0/JFIF
// unit 0 X/Y densities carry the pixel aspect ratio). The app must lay out
// and resize to the display aspect, not the coded one.
// Returns the display size, or null when it equals the coded size (PNG,
// missing/absolute-density JPEG metadata, malformed data). Malformed input
// never throws; it just yields null.
export function imageDisplaySize(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return null; // PNG: square pixels
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let coded = null;
  let ratio = null; // JFIF unit-0 X/Y density ratio
  // Header-only scan. SOS (0xDA) marks the start of entropy-coded data, and
  // EOI ends the image; scanning past either would read lengths from entropy
  // bytes. Standalone markers (TEM, RST0..7) carry no length.
  for (let i = 2; i + 1 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS: headers done
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) return null;
    const len = bytes.readUInt16BE(i + 2);
    if (len < 2) return null;
    const start = i + 4;
    const end = start + len - 2;
    if (end > bytes.length) return null; // truncated segment
    if (marker >= 0xc0 && marker <= 0xc3 && coded === null && end - start >= 5) {
      coded = { width: bytes.readUInt16BE(start + 3), height: bytes.readUInt16BE(start + 1) };
    } else if (marker === 0xe0 && end - start >= 12) {
      // APP0 with a JFIF signature: units 0 means X/Y densities are a ratio.
      const jfif = bytes[start] === 0x4a && bytes[start + 1] === 0x46 && bytes[start + 2] === 0x49 && bytes[start + 3] === 0x46 && bytes[start + 4] === 0x00;
      if (jfif) {
        // JFIF payload: "JFIF\0" (5), version (2), units (1), Xdensity (2), Ydensity (2).
        const units = bytes[start + 7];
        const xd = bytes.readUInt16BE(start + 8);
        const yd = bytes.readUInt16BE(start + 10);
        if (units === 0 && xd > 0 && yd > 0) ratio = xd / yd;
        // units 1/2 (absolute density) or a zero ratio: square pixels, null.
      }
    }
    i = end;
  }
  if (!coded || !ratio || !Number.isFinite(ratio)) return null;
  return { width: Math.max(1, Math.round(coded.width * ratio)), height: coded.height };
}
