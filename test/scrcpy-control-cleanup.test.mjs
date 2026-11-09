import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

// Fake adb: logs every invocation, simulates push/forward/shell, and the
// server shell stays alive until SIGTERM (so cleanup can be observed). The
// shell branch never falls through to an unconditional exit.
// Fake scrcpy: prints a version so `scrcpyVersion` never needs the real
// binary (it honors REX_SIM_SCRCPY).
const binDir = mkdtempSync(join(tmpdir(), "rex-control-"));
const sdk = join(binDir, "sdk");
const adbDir = join(sdk, "platform-tools");
const adbPath = join(adbDir, "adb");
const scrcpyPath = join(binDir, "scrcpy");
const logPath = join(binDir, "adb.log");
const jarPath = join(binDir, "fake-server.jar");
mkdirSync(adbDir, { recursive: true });
writeFileSync(jarPath, "dummy jar");
writeFileSync(adbPath, `#!/usr/bin/env node
const fs = require("fs");
const log = (line) => fs.appendFileSync(process.env.FAKE_ADB_LOG, line + "\\n");
const args = process.argv.slice(2);
log("adb " + args.join(" "));
if (args.includes("push")) process.exit(0);
if (args.includes("forward")) {
  if (args.includes("--remove")) {
    if (process.env.FAKE_ADB_REMOVE_FAIL === "1") process.exit(1);
    process.exit(0);
  }
  if (process.env.FAKE_ADB_FORWARD_FAIL === "1") {
    const gate = process.env.FAKE_ADB_GATE;
    const deadline = Date.now() + 5000;
    while (!gate || !fs.existsSync(gate)) {
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    process.exit(1);
  }
  console.log(process.env.FAKE_ADB_PORT || "0");
  process.exit(0);
}
if (args.includes("shell") && args.join(" ").includes("pkill")) process.exit(0);
if (args.includes("shell")) {
  process.on("SIGTERM", () => { log("shell TERM"); process.exit(0); });
  log("shell ready");
  setInterval(() => {}, 1000);
}
`);
writeFileSync(scrcpyPath, "#!/usr/bin/env node\nconsole.log('scrcpy 3.3.4');\n");
chmodSync(adbPath, 0o755);
chmodSync(scrcpyPath, 0o755);
process.env.ANDROID_HOME = sdk;
process.env.REX_SIM_SCRCPY = scrcpyPath;
process.env.REX_SIM_SCRCPY_SERVER = jarPath;
process.env.FAKE_ADB_LOG = logPath;

after(() => {
  delete process.env.ANDROID_HOME;
  delete process.env.REX_SIM_SCRCPY;
  delete process.env.REX_SIM_SCRCPY_SERVER;
  delete process.env.FAKE_ADB_LOG;
  delete process.env.FAKE_ADB_FORWARD_FAIL;
  delete process.env.FAKE_ADB_PORT;
  rmSync(binDir, { recursive: true, force: true });
});

function logLines() {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function tcpServer(onConnection) {
  const srv = net.createServer((sock) => onConnection(sock));
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

async function waitForLog(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logLines().some(predicate)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("startVideoSocket cleans up when adb forward fails", { timeout: 20000 }, async (t) => {
  rmSync(logPath, { force: true });
  const gate = join(binDir, "forward-gate");
  rmSync(gate, { force: true });
  process.env.FAKE_ADB_FORWARD_FAIL = "1";
  process.env.FAKE_ADB_GATE = gate;
  t.after(() => {
    delete process.env.FAKE_ADB_FORWARD_FAIL;
    delete process.env.FAKE_ADB_GATE;
    rmSync(gate, { force: true });
  });
  const { startVideoSocket } = await import("../src/scrcpy-control.mjs");
  const starting = startVideoSocket("serial");
  assert.equal(await waitForLog((l) => l.includes("shell ready")), true, "server shell never became ready");
  writeFileSync(gate, "");
  await assert.rejects(starting, /Command failed/);
  await new Promise((r) => setTimeout(r, 150));
  const lines = logLines();
  assert.ok(lines.some((l) => l.includes("pkill")), "remote server was not pkill'ed");
  assert.ok(lines.some((l) => l.includes("shell TERM")), "server shell was not killed");
  assert.ok(!lines.some((l) => l.includes("forward --remove")), "forward remove attempted without a port");
});

test("startVideoSocket success path performs the dummy handshake, closes once, removes forward once", { timeout: 20000 }, async (t) => {
  rmSync(logPath, { force: true });
  let socket;
  let close;
  let accepted = 0;
  const { srv, port } = await tcpServer((sock) => {
    accepted++;
    sock.write(Buffer.from([0x00])); // the handshake dummy byte
  });
  process.env.FAKE_ADB_PORT = String(port);
  t.after(async () => {
    try { socket?.destroy(); } catch {}
    delete process.env.FAKE_ADB_PORT;
    await new Promise((r) => srv.close(r));
  });
  const { startVideoSocket } = await import("../src/scrcpy-control.mjs");
  ({ socket, close } = await startVideoSocket("serial"));
  assert.equal(socket.destroyed, false);
  assert.equal(accepted, 1, "expected exactly one accepted handshake connection");
  close();
  close(); // idempotent
  await new Promise((r) => setTimeout(r, 150));
  const lines = logLines();
  assert.equal(lines.filter((l) => l.includes("shell TERM")).length, 1, "expected exactly one server kill");
  assert.equal(lines.filter((l) => l.includes("forward --remove")).length, 1, "expected exactly one forward remove");
  assert.equal(lines.filter((l) => l.includes("pkill")).length, 1, "expected exactly one pkill");
});

test("handshake retries a pre-byte close and consumes only the dummy byte", { timeout: 20000 }, async () => {
  let connections = 0;
  const { srv, port } = await tcpServer((sock) => {
    connections++;
    if (connections === 1) {
      sock.destroy(); // pre-handshake close: must trigger exactly one retry
      return;
    }
    // dummy + real payload in the SAME write: only the dummy may be consumed
    sock.write(Buffer.concat([Buffer.from([0x00]), Buffer.from("REALSTREAM")]));
    sock.end();
  });
  const { connectWithRetry } = await import("../src/scrcpy-control.mjs");
  try {
    const socket = await connectWithRetry(port, 3000);
    assert.equal(connections, 2, "expected exactly one retry");
    assert.equal(socket.destroyed, false);
    const payload = await new Promise((resolve, reject) => {
      const chunks = [];
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });
    assert.equal(payload, "REALSTREAM", "payload after the dummy byte must be intact");
    socket.destroy();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("a malformed dummy byte fails the attempt and never resolves as success", { timeout: 20000 }, async () => {
  let connections = 0;
  const { srv, port } = await tcpServer((sock) => {
    connections++;
    if (connections === 1) {
      sock.write(Buffer.concat([Buffer.from([0x01]), Buffer.from("BAD")]));
      sock.end();
      return;
    }
    sock.write(Buffer.concat([Buffer.from([0x00]), Buffer.from("GOOD")]));
    sock.end();
  });
  const { connectWithRetry } = await import("../src/scrcpy-control.mjs");
  try {
    const socket = await connectWithRetry(port, 3000);
    assert.equal(connections, 2, "malformed byte must trigger a retry, not success");
    const payload = await new Promise((resolve, reject) => {
      const chunks = [];
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });
    assert.equal(payload, "GOOD", "payload after the valid handshake must arrive intact");
    socket.destroy();
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("handshake preserves the socket's internal end semantics", { timeout: 20000 }, async () => {
  const { srv, port } = await tcpServer((sock) => {
    sock.write(Buffer.concat([Buffer.from([0x00]), Buffer.from("ENDDATA")]));
    sock.end();
  });
  const { connectWithRetry } = await import("../src/scrcpy-control.mjs");
  try {
    const socket = await connectWithRetry(port, 3000);
    const seen = await new Promise((resolve) => {
      const chunks = [];
      let ended = false;
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => { ended = true; });
      socket.on("close", () => resolve({ payload: Buffer.concat(chunks).toString("utf8"), ended }));
    });
    assert.equal(seen.payload, "ENDDATA");
    assert.equal(seen.ended, true, "end must be observed after the peer finishes");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("accepted-but-silent connections reject by the overall deadline", { timeout: 20000 }, async () => {
  const clientSockets = new Set();
  const { srv, port } = await tcpServer((sock) => {
    clientSockets.add(sock);
    sock.on("close", () => clientSockets.delete(sock));
    // never send the dummy byte
  });
  const { connectWithRetry } = await import("../src/scrcpy-control.mjs");
  try {
    await assert.rejects(connectWithRetry(port, 500), /didn't accept/);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(clientSockets.size, 0, "failed attempts must destroy their sockets");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("startControlSocket performs the dummy handshake and stays writable", { timeout: 20000 }, async (t) => {
  rmSync(logPath, { force: true });
  let socket;
  let close;
  let received = Buffer.alloc(0);
  const { srv, port } = await tcpServer((sock) => {
    sock.write(Buffer.from([0x00])); // dummy
    sock.on("data", (c) => { received = Buffer.concat([received, c]); });
  });
  process.env.FAKE_ADB_PORT = String(port);
  t.after(async () => {
    try { socket?.destroy(); } catch {}
    delete process.env.FAKE_ADB_PORT;
    await new Promise((r) => srv.close(r));
  });
  const { startControlSocket } = await import("../src/scrcpy-control.mjs");
  ({ socket, close } = await startControlSocket("serial"));
  socket.write(Buffer.from("abc"));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received.toString("utf8"), "abc", "control writes must arrive after handshake");
  close();
  close();
  await new Promise((r) => setTimeout(r, 150));
  const shellLine = logLines().find((l) => l.startsWith("adb") && l.includes("shell") && l.includes("CLASSPATH"));
  assert.ok(shellLine?.includes("send_dummy_byte=true"), "control server must request the dummy byte");
  assert.ok(shellLine?.includes("send_device_meta=false"), "control server keeps device meta off");
});

test("forward removal retries at close when the early removal fails", { timeout: 20000 }, async (t) => {
  rmSync(logPath, { force: true });
  let socket;
  let close;
  const { srv, port } = await tcpServer((sock) => {
    sock.write(Buffer.from([0x00]));
  });
  process.env.FAKE_ADB_PORT = String(port);
  process.env.FAKE_ADB_REMOVE_FAIL = "1"; // early removal fails
  t.after(async () => {
    try { socket?.destroy(); } catch {}
    delete process.env.FAKE_ADB_PORT;
    delete process.env.FAKE_ADB_REMOVE_FAIL;
    await new Promise((r) => srv.close(r));
  });
  const { startVideoSocket } = await import("../src/scrcpy-control.mjs");
  ({ socket, close } = await startVideoSocket("serial")); // handshake ok; early removal failed
  const attemptedEarly = logLines().filter((l) => l.includes("forward --remove")).length;
  assert.equal(attemptedEarly, 1, "early removal should have been attempted once");
  delete process.env.FAKE_ADB_REMOVE_FAIL; // close retry will succeed
  close();
  await new Promise((r) => setTimeout(r, 150));
  const attemptedTotal = logLines().filter((l) => l.includes("forward --remove")).length;
  assert.equal(attemptedTotal, 2, "close must retry the removal");
});

test("startVideoSocket removes a late-acquired forward when connect times out", { timeout: 20000 }, async (t) => {
  rmSync(logPath, { force: true });
  const clientSockets = new Set();
  const { srv, port } = await tcpServer((sock) => {
    clientSockets.add(sock);
    sock.on("close", () => clientSockets.delete(sock));
    // silent: accepted but never sends the dummy byte
  });
  process.env.FAKE_ADB_PORT = String(port);
  t.after(async () => {
    delete process.env.FAKE_ADB_PORT;
    await new Promise((r) => srv.close(r));
  });
  const { startVideoSocket } = await import("../src/scrcpy-control.mjs");
  await assert.rejects(startVideoSocket("serial", {}, { connectTimeoutMs: 600 }), /didn't accept/);
  await new Promise((r) => setTimeout(r, 150));
  const lines = logLines();
  assert.ok(lines.some((l) => l.includes("forward --remove") && l.includes(`tcp:${port}`)), "late-acquired forward must be removed");
  assert.ok(lines.some((l) => l.includes("shell TERM")), "server shell must be killed");
  assert.equal(clientSockets.size, 0, "connect attempts must destroy their sockets");
});
