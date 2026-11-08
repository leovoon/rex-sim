// JPEG frames from a multipart/x-mixed-replace stream, as they arrive.
export async function* jpegFrames(url, signal) {
  const res = await fetch(url, { signal });
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
}

// Width and height from a JPEG's start-of-frame segment.
export function jpegSize(jpg) {
  let i = 2;
  while (i + 9 < jpg.length) {
    const marker = jpg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: jpg.readUInt16BE(i + 7), height: jpg.readUInt16BE(i + 5) };
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  return null;
}
