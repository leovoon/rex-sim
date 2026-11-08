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
